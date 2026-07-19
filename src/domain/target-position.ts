import { randomUUID } from "node:crypto";

import { Decimal } from "decimal.js";

import { quoteBuy, quoteSell } from "./order-book.js";
import type {
  DiscoveredEvent,
  OrderBook,
  PendingOrder,
  ReconciliationDecision,
  ReconciliationPlan,
  TrackedAsset,
  UserPosition,
} from "./types.js";

export interface TargetPlannerInput {
  event: DiscoveredEvent;
  leaderPositions: UserPosition[];
  followerPositions: UserPosition[];
  pendingOrders: PendingOrder[];
  books: Map<string, OrderBook>;
  copyRatio: string;
  maxOpenDebit: string;
  maxEventLoss: string;
  realizedLoss: string;
  maxPriceDriftAbs: string;
  maxSlippageBps: number;
  maxBookAgeMs: number;
  nowMs: number;
  allowBuys: boolean;
  unconfirmedLeaderZeroTokens: Set<string>;
}

const ZERO = new Decimal(0);
const POSITION_EPSILON = new Decimal("0.000001");

function mapPositions(positions: UserPosition[], allowedTokens: Set<string>, label: string): Map<string, UserPosition> {
  const result = new Map<string, UserPosition>();
  for (const position of positions) {
    if (!allowedTokens.has(position.tokenId)) {
      throw new Error(`${label} position contains token outside event allowlist: ${position.tokenId}`);
    }
    if (result.has(position.tokenId)) {
      throw new Error(`${label} returned duplicate position for token ${position.tokenId}`);
    }
    result.set(position.tokenId, position);
  }
  return result;
}

function groupPendingOrders(orders: PendingOrder[], allowedTokens: Set<string>): Map<string, PendingOrder[]> {
  const result = new Map<string, PendingOrder[]>();
  for (const order of orders) {
    if (!allowedTokens.has(order.tokenId)) {
      throw new Error(`Pending order contains token outside event allowlist: ${order.tokenId}`);
    }
    const existing = result.get(order.tokenId) ?? [];
    existing.push(order);
    result.set(order.tokenId, existing);
  }
  return result;
}

function effectiveSize(confirmed: Decimal, orders: PendingOrder[]): Decimal {
  return orders.reduce((size, order) => {
    const remaining = new Decimal(order.remainingShares);
    return order.side === "BUY" ? size.plus(remaining) : size.minus(remaining);
  }, confirmed);
}

function calculateAvailableRisk(maxOpenDebit: Decimal, maxEventLoss: Decimal, realizedLoss: Decimal): Decimal {
  const lossRemaining = Decimal.max(ZERO, maxEventLoss.minus(Decimal.max(ZERO, realizedLoss)));
  return Decimal.min(maxOpenDebit, lossRemaining);
}

function estimateTargetRisk(
  scale: Decimal,
  rawTargets: Map<string, Decimal>,
  assets: Map<string, TrackedAsset>,
  books: Map<string, OrderBook>,
): Decimal | null {
  let total = new Decimal(0);
  for (const [tokenId, rawTarget] of rawTargets) {
    const target = rawTarget.mul(scale);
    if (target.lessThanOrEqualTo(POSITION_EPSILON)) {
      continue;
    }
    const asset = assets.get(tokenId);
    const book = books.get(tokenId);
    if (!asset || !book) {
      return null;
    }
    const quote = quoteBuy(book, target, asset.feeSchedule);
    if (!quote.complete) {
      return null;
    }
    total = total.plus(quote.totalDebit);
  }
  return total;
}

function solveCapScale(
  rawTargets: Map<string, Decimal>,
  assets: Map<string, TrackedAsset>,
  books: Map<string, OrderBook>,
  availableRisk: Decimal,
): { scale: Decimal; risk: Decimal } {
  if ([...rawTargets.values()].every((value) => value.lessThanOrEqualTo(POSITION_EPSILON))) {
    return { scale: new Decimal(1), risk: new Decimal(0) };
  }

  const fullRisk = estimateTargetRisk(new Decimal(1), rawTargets, assets, books);
  if (fullRisk !== null && fullRisk.lessThanOrEqualTo(availableRisk)) {
    return { scale: new Decimal(1), risk: fullRisk };
  }

  let low = new Decimal(0);
  let high = new Decimal(1);
  let lowRisk = new Decimal(0);
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = low.plus(high).div(2);
    const risk = estimateTargetRisk(midpoint, rawTargets, assets, books);
    if (risk !== null && risk.lessThanOrEqualTo(availableRisk)) {
      low = midpoint;
      lowRisk = risk;
    } else {
      high = midpoint;
    }
  }
  return { scale: low, risk: lowRisk };
}

function isBookStale(book: OrderBook, nowMs: number, maxBookAgeMs: number): boolean {
  if (book.timestampMs <= 0) {
    return true;
  }
  return nowMs - book.timestampMs > maxBookAgeMs;
}

function priceLimitForBuy(avgPrice: Decimal, drift: Decimal, slippageBps: number): Decimal | null {
  if (avgPrice.lessThanOrEqualTo(0)) {
    return null;
  }
  const absoluteLimit = avgPrice.plus(drift);
  const relativeLimit = avgPrice.mul(new Decimal(1).plus(new Decimal(slippageBps).div(10_000)));
  return Decimal.min(absoluteLimit, relativeLimit);
}

function baseDecision(
  asset: TrackedAsset,
  leaderSize: Decimal,
  rawTarget: Decimal,
  target: Decimal,
  confirmed: Decimal,
  effective: Decimal,
  delta: Decimal,
): Omit<ReconciliationDecision, "action" | "estimatedDebit" | "estimatedProceeds" | "worstPrice" | "reason"> {
  return {
    tokenId: asset.tokenId,
    marketSlug: asset.marketSlug,
    outcome: asset.outcome,
    leaderSize: leaderSize.toFixed(),
    rawTargetSize: rawTarget.toFixed(),
    targetSize: target.toFixed(),
    confirmedSize: confirmed.toFixed(),
    effectiveSize: effective.toFixed(),
    deltaSize: delta.toFixed(),
  };
}

export function buildReconciliationPlan(input: TargetPlannerInput): ReconciliationPlan {
  const copyRatio = new Decimal(input.copyRatio);
  const maxOpenDebit = new Decimal(input.maxOpenDebit);
  const maxEventLoss = new Decimal(input.maxEventLoss);
  const realizedLoss = Decimal.max(ZERO, new Decimal(input.realizedLoss));
  const availableRisk = calculateAvailableRisk(maxOpenDebit, maxEventLoss, realizedLoss);
  const allowedTokens = new Set(input.event.assets.map((asset) => asset.tokenId));
  const assets = new Map(input.event.assets.map((asset) => [asset.tokenId, asset]));
  const leader = mapPositions(input.leaderPositions, allowedTokens, "Leader");
  const follower = mapPositions(input.followerPositions, allowedTokens, "Follower");
  const pending = groupPendingOrders(input.pendingOrders, allowedTokens);
  const rawTargets = new Map<string, Decimal>();

  for (const asset of input.event.assets) {
    const leaderSize = new Decimal(leader.get(asset.tokenId)?.size ?? 0);
    rawTargets.set(asset.tokenId, leaderSize.mul(copyRatio));
  }

  const { scale, risk: estimatedTargetRisk } = solveCapScale(rawTargets, assets, input.books, availableRisk);
  const drift = new Decimal(input.maxPriceDriftAbs);
  const decisions: ReconciliationDecision[] = [];

  for (const asset of input.event.assets) {
    const leaderPosition = leader.get(asset.tokenId);
    const followerPosition = follower.get(asset.tokenId);
    const leaderSize = new Decimal(leaderPosition?.size ?? 0);
    const rawTarget = rawTargets.get(asset.tokenId) ?? ZERO;
    const target = rawTarget.mul(scale);
    const confirmed = new Decimal(followerPosition?.size ?? 0);
    const effective = effectiveSize(confirmed, pending.get(asset.tokenId) ?? []);
    const delta = target.minus(effective);
    const base = baseDecision(asset, leaderSize, rawTarget, target, confirmed, effective, delta);
    const minimum = new Decimal(asset.minOrderSize);

    if (delta.abs().lessThanOrEqualTo(POSITION_EPSILON)) {
      decisions.push({
        ...base,
        action: "HOLD",
        estimatedDebit: "0",
        estimatedProceeds: "0",
        worstPrice: null,
        reason: "already_aligned",
      });
      continue;
    }

    if (delta.abs().lessThan(minimum)) {
      decisions.push({
        ...base,
        action: "HOLD",
        estimatedDebit: "0",
        estimatedProceeds: "0",
        worstPrice: null,
        reason: "below_min_order_size",
      });
      continue;
    }

    if (delta.isNegative() && input.unconfirmedLeaderZeroTokens.has(asset.tokenId)) {
      decisions.push({
        ...base,
        action: "SKIP",
        estimatedDebit: "0",
        estimatedProceeds: "0",
        worstPrice: null,
        reason: "unconfirmed_leader_zero_snapshot",
      });
      continue;
    }

    const book = input.books.get(asset.tokenId);
    if (!book) {
      decisions.push({
        ...base,
        action: "SKIP",
        estimatedDebit: "0",
        estimatedProceeds: "0",
        worstPrice: null,
        reason: "missing_order_book",
      });
      continue;
    }

    if (isBookStale(book, input.nowMs, input.maxBookAgeMs)) {
      decisions.push({
        ...base,
        action: "SKIP",
        estimatedDebit: "0",
        estimatedProceeds: "0",
        worstPrice: null,
        reason: "stale_order_book",
      });
      continue;
    }

    if (delta.isPositive()) {
      if (!input.allowBuys || !asset.acceptingOrders) {
        decisions.push({
          ...base,
          action: "SKIP",
          estimatedDebit: "0",
          estimatedProceeds: "0",
          worstPrice: null,
          reason: input.allowBuys ? "market_not_accepting_orders" : "event_buy_window_closed",
        });
        continue;
      }

      const leaderAverage = new Decimal(leaderPosition?.avgPrice ?? 0);
      const maxPrice = priceLimitForBuy(leaderAverage, drift, input.maxSlippageBps);
      const quote = quoteBuy(book, delta, asset.feeSchedule, maxPrice ?? undefined);
      if (!quote.complete) {
        decisions.push({
          ...base,
          action: "SKIP",
          estimatedDebit: quote.totalDebit.toFixed(),
          estimatedProceeds: "0",
          worstPrice: quote.worstPrice?.toFixed() ?? null,
          reason: maxPrice === null ? "insufficient_ask_liquidity" : "price_drift_or_insufficient_ask_liquidity",
        });
        continue;
      }

      decisions.push({
        ...base,
        action: "BUY",
        estimatedDebit: quote.totalDebit.toFixed(),
        estimatedProceeds: "0",
        worstPrice: quote.worstPrice?.toFixed() ?? null,
        reason: "target_position_deficit",
      });
      continue;
    }

    const sellSize = Decimal.min(delta.abs(), confirmed);
    if (sellSize.lessThan(minimum)) {
      decisions.push({
        ...base,
        action: "HOLD",
        estimatedDebit: "0",
        estimatedProceeds: "0",
        worstPrice: null,
        reason: "sellable_balance_below_min_order_size",
      });
      continue;
    }

    const quote = quoteSell(book, sellSize, asset.feeSchedule);
    if (!quote.complete) {
      decisions.push({
        ...base,
        action: "SKIP",
        estimatedDebit: "0",
        estimatedProceeds: quote.netProceeds.toFixed(),
        worstPrice: quote.worstPrice?.toFixed() ?? null,
        reason: "insufficient_bid_liquidity",
      });
      continue;
    }

    decisions.push({
      ...base,
      action: "SELL",
      estimatedDebit: "0",
      estimatedProceeds: quote.netProceeds.toFixed(),
      worstPrice: quote.worstPrice?.toFixed() ?? null,
      reason: "target_position_surplus",
    });
  }

  return {
    runId: randomUUID(),
    eventId: input.event.eventId,
    eventSlug: input.event.eventSlug,
    copyRatio: copyRatio.toFixed(),
    capScale: scale.toFixed(),
    maxEventRisk: maxOpenDebit.toFixed(),
    realizedLoss: realizedLoss.toFixed(),
    availableRisk: availableRisk.toFixed(),
    estimatedTargetRisk: estimatedTargetRisk.toFixed(),
    createdAt: new Date(input.nowMs).toISOString(),
    decisions,
  };
}
