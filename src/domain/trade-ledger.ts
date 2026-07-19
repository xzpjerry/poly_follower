import { Decimal } from "decimal.js";

import { calculateTakerFee } from "./fees.js";
import type {
  FollowerTrade,
  ReconstructedEventLedger,
  TrackedAsset,
  UserPosition,
} from "./types.js";

interface TokenLedger {
  size: Decimal;
  costBasis: Decimal;
}

export interface PositionMismatch {
  tokenId: string;
  publicSize: string;
  reconstructedSize: string;
}

const ZERO = new Decimal(0);
const SIZE_EPSILON = new Decimal("0.000001");

function compareMatchedAt(left: FollowerTrade, right: FollowerTrade): number {
  if (/^\d+$/.test(left.matchedAt) && /^\d+$/.test(right.matchedAt)) {
    const leftNanos = BigInt(left.matchedAt);
    const rightNanos = BigInt(right.matchedAt);
    return leftNanos < rightNanos ? -1 : leftNanos > rightNanos ? 1 : left.tradeId.localeCompare(right.tradeId);
  }
  const leftTime = Date.parse(left.matchedAt);
  const rightTime = Date.parse(right.matchedAt);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  const lexical = left.matchedAt.localeCompare(right.matchedAt);
  return lexical === 0 ? left.tradeId.localeCompare(right.tradeId) : lexical;
}

export function reconstructEventLedger(
  trades: FollowerTrade[],
  assets: TrackedAsset[],
): ReconstructedEventLedger {
  const assetByToken = new Map(assets.map((asset) => [asset.tokenId, asset]));
  const ledgerByToken = new Map<string, TokenLedger>();
  const seenTradeIds = new Set<string>();
  let realizedLoss = new Decimal(0);
  let grossBuyDebit = new Decimal(0);
  let tradeCount = 0;

  const sortedTrades = [...trades].sort(compareMatchedAt);

  for (const trade of sortedTrades) {
    if (trade.status === "FAILED") {
      continue;
    }
    if (seenTradeIds.has(trade.tradeId)) {
      continue;
    }
    seenTradeIds.add(trade.tradeId);

    const asset = assetByToken.get(trade.tokenId);
    if (!asset) {
      throw new Error(`Authenticated trade contains token outside event allowlist: ${trade.tokenId}`);
    }
    const size = new Decimal(trade.size);
    const price = new Decimal(trade.price);
    if (!size.isPositive() || price.isNegative() || price.greaterThan(1)) {
      throw new Error(`Authenticated trade ${trade.tradeId} has invalid size or price`);
    }

    const tokenLedger = ledgerByToken.get(trade.tokenId) ?? {
      size: new Decimal(0),
      costBasis: new Decimal(0),
    };
    const fee = trade.traderSide === "TAKER" ? calculateTakerFee(size, price, asset.feeSchedule) : ZERO;
    const notional = size.mul(price);

    if (trade.side === "BUY") {
      const debit = notional.plus(fee);
      tokenLedger.size = tokenLedger.size.plus(size);
      tokenLedger.costBasis = tokenLedger.costBasis.plus(debit);
      grossBuyDebit = grossBuyDebit.plus(debit);
    } else {
      if (size.greaterThan(tokenLedger.size.plus(SIZE_EPSILON))) {
        throw new Error(`Trade history is incomplete for token ${trade.tokenId}: sell exceeds reconstructed balance`);
      }
      const sellSize = Decimal.min(size, tokenLedger.size);
      const releasedCost = tokenLedger.size.isZero()
        ? ZERO
        : tokenLedger.costBasis.mul(sellSize).div(tokenLedger.size);
      const proceeds = notional.minus(fee);
      const pnl = proceeds.minus(releasedCost);
      if (pnl.isNegative()) {
        realizedLoss = realizedLoss.plus(pnl.abs());
      }
      tokenLedger.size = tokenLedger.size.minus(sellSize);
      tokenLedger.costBasis = Decimal.max(ZERO, tokenLedger.costBasis.minus(releasedCost));
    }

    if (tokenLedger.size.abs().lessThanOrEqualTo(SIZE_EPSILON)) {
      tokenLedger.size = new Decimal(0);
      tokenLedger.costBasis = new Decimal(0);
    }
    ledgerByToken.set(trade.tokenId, tokenLedger);
    tradeCount += 1;
  }

  return {
    sizes: new Map([...ledgerByToken].map(([tokenId, ledger]) => [tokenId, ledger.size.toFixed()])),
    realizedLoss: realizedLoss.toFixed(),
    grossBuyDebit: grossBuyDebit.toFixed(),
    tradeCount,
  };
}

export function compareLedgerToPublicPositions(
  ledger: ReconstructedEventLedger,
  positions: UserPosition[],
  trackedTokenIds: string[],
  tolerance: Decimal.Value = "0.0001",
): PositionMismatch[] {
  const publicSizes = new Map(positions.map((position) => [position.tokenId, new Decimal(position.size)]));
  const allowedDifference = new Decimal(tolerance);
  const mismatches: PositionMismatch[] = [];

  for (const tokenId of trackedTokenIds) {
    const publicSize = publicSizes.get(tokenId) ?? ZERO;
    const reconstructedSize = new Decimal(ledger.sizes.get(tokenId) ?? 0);
    if (publicSize.minus(reconstructedSize).abs().greaterThan(allowedDifference)) {
      mismatches.push({
        tokenId,
        publicSize: publicSize.toFixed(),
        reconstructedSize: reconstructedSize.toFixed(),
      });
    }
  }
  return mismatches;
}
