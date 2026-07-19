import { Decimal } from "decimal.js";

import { calculateTakerFee } from "./fees.js";
import type { FeeSchedule, OrderBook, OrderBookLevel } from "./types.js";

export interface TradeQuote {
  requestedShares: Decimal;
  filledShares: Decimal;
  notional: Decimal;
  fee: Decimal;
  totalDebit: Decimal;
  netProceeds: Decimal;
  worstPrice: Decimal | null;
  complete: boolean;
}

function emptyQuote(requestedShares: Decimal): TradeQuote {
  return {
    requestedShares,
    filledShares: new Decimal(0),
    notional: new Decimal(0),
    fee: new Decimal(0),
    totalDebit: new Decimal(0),
    netProceeds: new Decimal(0),
    worstPrice: null,
    complete: requestedShares.isZero(),
  };
}

function quoteLevels(
  requestedShares: Decimal.Value,
  levels: OrderBookLevel[],
  feeSchedule: FeeSchedule,
  priceAllowed: (price: Decimal) => boolean,
): TradeQuote {
  const requested = new Decimal(requestedShares);
  if (requested.isNegative()) {
    throw new Error("Requested shares cannot be negative");
  }

  const quote = emptyQuote(requested);
  let remaining = requested;

  for (const level of levels) {
    if (remaining.isZero()) {
      break;
    }
    const price = new Decimal(level.price);
    const available = new Decimal(level.size);
    if (!priceAllowed(price)) {
      break;
    }
    if (available.lessThanOrEqualTo(0)) {
      continue;
    }

    const fill = Decimal.min(remaining, available);
    quote.filledShares = quote.filledShares.plus(fill);
    quote.notional = quote.notional.plus(fill.mul(price));
    quote.fee = quote.fee.plus(calculateTakerFee(fill, price, feeSchedule));
    quote.worstPrice = price;
    remaining = remaining.minus(fill);
  }

  quote.totalDebit = quote.notional.plus(quote.fee);
  quote.netProceeds = quote.notional.minus(quote.fee);
  quote.complete = remaining.isZero();
  return quote;
}

export function quoteBuy(
  book: OrderBook,
  requestedShares: Decimal.Value,
  feeSchedule: FeeSchedule,
  maxPrice?: Decimal.Value,
): TradeQuote {
  const priceLimit = maxPrice === undefined ? null : new Decimal(maxPrice);
  return quoteLevels(
    requestedShares,
    book.asks,
    feeSchedule,
    (price) => priceLimit === null || price.lessThanOrEqualTo(priceLimit),
  );
}

export function quoteSell(
  book: OrderBook,
  requestedShares: Decimal.Value,
  feeSchedule: FeeSchedule,
  minPrice?: Decimal.Value,
): TradeQuote {
  const priceLimit = minPrice === undefined ? null : new Decimal(minPrice);
  return quoteLevels(
    requestedShares,
    book.bids,
    feeSchedule,
    (price) => priceLimit === null || price.greaterThanOrEqualTo(priceLimit),
  );
}
