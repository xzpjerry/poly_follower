import { Decimal } from "decimal.js";

import type { FeeSchedule } from "./types.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

export function calculateTakerFee(shares: Decimal.Value, price: Decimal.Value, schedule: FeeSchedule): Decimal {
  if (!schedule.enabled) {
    return new Decimal(0);
  }

  const quantity = new Decimal(shares);
  const probability = new Decimal(price);
  const rate = new Decimal(schedule.rate);
  if (quantity.isNegative() || probability.isNegative() || probability.greaterThan(1) || rate.isNegative()) {
    throw new Error("Invalid fee input");
  }

  const curveBase = probability.mul(new Decimal(1).minus(probability));
  return quantity.mul(rate).mul(curveBase.pow(schedule.exponent));
}
