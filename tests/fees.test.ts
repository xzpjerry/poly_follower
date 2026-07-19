import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import { calculateTakerFee } from "../src/domain/fees.js";
import { weatherFee } from "./fixtures.js";

describe("calculateTakerFee", () => {
  it("matches the observed Shenzhen weather trade fee", () => {
    const fee = calculateTakerFee("47", "0.29", weatherFee);
    expect(fee.toFixed(6)).toBe("0.483865");
    expect(new Decimal("47").mul("0.29").plus(fee).toFixed(6)).toBe("14.113865");
  });
});
