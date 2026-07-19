import { Decimal } from "decimal.js";
import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import { buildReconciliationPlan } from "../domain/target-position.js";
import type { DiscoveredEvent, OrderBook, ReconciliationPlan, UserPosition } from "../domain/types.js";
import { StateDatabase } from "../persistence/database.js";
import { ClobPublicClient } from "../polymarket/clob-public-client.js";
import { DataClient } from "../polymarket/data-client.js";
import { GammaClient } from "../polymarket/gamma-client.js";

function filterAllowedPositions(
  positions: UserPosition[],
  event: DiscoveredEvent,
  role: string,
  logger: Logger,
): UserPosition[] {
  const allowed = new Set(event.assets.map((asset) => asset.tokenId));
  const included: UserPosition[] = [];
  for (const position of positions) {
    if (allowed.has(position.tokenId)) {
      included.push(position);
    } else {
      logger.warn({ role, tokenId: position.tokenId, eventId: event.eventId }, "Ignored position outside token filter");
    }
  }
  return included;
}

function eventAllowsBuys(event: DiscoveredEvent, nowMs: number, stopBeforeEndSeconds: number): boolean {
  if (!event.active || event.closed) {
    return false;
  }
  const endMs = Date.parse(event.endDate);
  if (!Number.isFinite(endMs)) {
    return false;
  }
  return nowMs < endMs - stopBeforeEndSeconds * 1000;
}

export class Reconciler {
  public constructor(
    private readonly config: AppConfig,
    private readonly gamma: GammaClient,
    private readonly data: DataClient,
    private readonly clob: ClobPublicClient,
    private readonly state: StateDatabase,
    private readonly logger: Logger,
  ) {}

  public async discover(): Promise<DiscoveredEvent> {
    const event = await this.gamma.getEventBySlug(this.config.scope.eventSlug, {
      includeYes: this.config.scope.includeYesTokens,
      includeNo: this.config.scope.includeNoTokens,
    });
    this.state.upsertEvent(event);
    return event;
  }

  public async runOnce(eventOverride?: DiscoveredEvent): Promise<ReconciliationPlan> {
    const nowMs = Date.now();
    const event = eventOverride ?? (await this.discover());
    const leaderPositionsRaw = await this.data.getPositions(this.config.leaderProfileWallet, event.eventId);
    const followerPositionsRaw = this.config.followerProfileWallet
      ? await this.data.getPositions(this.config.followerProfileWallet, event.eventId)
      : [];
    const leaderPositions = filterAllowedPositions(leaderPositionsRaw, event, "leader", this.logger);
    const followerPositions = filterAllowedPositions(followerPositionsRaw, event, "follower", this.logger);
    const unconfirmedLeaderZeroTokens = this.state.observeLeaderPositions(
      event.eventId,
      this.config.leaderProfileWallet,
      event.assets.map((asset) => asset.tokenId),
      leaderPositions,
    );

    this.state.recordPositions(event.eventId, this.config.leaderProfileWallet, "leader", leaderPositions);
    this.state.recordPositions(
      event.eventId,
      this.config.followerProfileWallet ?? "simulated-empty-follower",
      "follower",
      followerPositions,
    );

    const activeTokenIds = new Set([
      ...leaderPositions.filter((position) => new Decimal(position.size).greaterThan(0)).map((position) => position.tokenId),
      ...followerPositions.filter((position) => new Decimal(position.size).greaterThan(0)).map((position) => position.tokenId),
    ]);
    const books = new Map<string, OrderBook>();
    await Promise.all(
      [...activeTokenIds].map(async (tokenId) => {
        try {
          books.set(tokenId, await this.clob.getOrderBook(tokenId));
        } catch (error) {
          this.logger.error({ tokenId, error }, "Failed to fetch order book; token will fail closed");
        }
      }),
    );

    const followerLedgerKey = this.config.followerProfileWallet ?? "simulated-empty-follower";
    const plan = buildReconciliationPlan({
      event,
      leaderPositions,
      followerPositions,
      pendingOrders: this.state.getOpenOrders(event.eventId),
      books,
      copyRatio: this.config.copy.shareRatio,
      maxOpenDebit: this.config.risk.maxOpenDebitUsd,
      maxEventLoss: this.config.risk.maxEventLossUsd,
      realizedLoss: this.state.getRealizedLoss(event.eventId, followerLedgerKey),
      maxPriceDriftAbs: this.config.execution.maxPriceDriftAbs,
      maxSlippageBps: this.config.execution.maxSlippageBps,
      maxBookAgeMs: this.config.execution.maxBookAgeMs,
      nowMs,
      allowBuys: eventAllowsBuys(event, nowMs, this.config.execution.stopBeforeEndSeconds),
      unconfirmedLeaderZeroTokens,
    });
    this.state.recordPlan(plan);

    const actionable = plan.decisions.filter((decision) => decision.action === "BUY" || decision.action === "SELL");
    const skipped = plan.decisions.filter((decision) => decision.action === "SKIP");
    const decisionSummary = plan.decisions.reduce<Record<string, number>>((summary, decision) => {
      const key = `${decision.action}:${decision.reason}`;
      summary[key] = (summary[key] ?? 0) + 1;
      return summary;
    }, {});
    this.logger.info(
      {
        runId: plan.runId,
        eventId: plan.eventId,
        eventSlug: plan.eventSlug,
        capScale: plan.capScale,
        estimatedTargetRisk: plan.estimatedTargetRisk,
        actionable: actionable.length,
        skipped: skipped.length,
        decisionSummary,
        dryRun: true,
      },
      "Reconciliation completed",
    );
    for (const decision of [...actionable, ...skipped]) {
      this.logger.info({ runId: plan.runId, ...decision, dryRun: true }, "Dry-run decision");
    }
    return plan;
  }
}
