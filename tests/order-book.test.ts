import { describe, expect, it } from "vitest";

import { quoteBuy, quoteSell } from "../src/domain/order-book.js";
import { makeBook, weatherFee } from "./fixtures.js";

describe("order book quoting", () => {
  it("walks ask levels and includes taker fees", () => {
    const book = makeBook("token", [
      { price: "0.29", size: "10" },
      { price: "0.30", size: "10" },
    ]);
    const quote = quoteBuy(book, "15", weatherFee);

    expect(quote.complete).toBe(true);
    expect(quote.filledShares.toFixed()).toBe("15");
    expect(quote.notional.toFixed(2)).toBe("4.40");
    expect(quote.worstPrice?.toFixed()).toBe("0.3");
    expect(quote.totalDebit.greaterThan(quote.notional)).toBe(true);
  });

  it("reports incomplete liquidity without inventing a fill", () => {
    const book = makeBook("token", [{ price: "0.29", size: "4" }]);
    const quote = quoteBuy(book, "5", weatherFee);

    expect(quote.complete).toBe(false);
    expect(quote.filledShares.toFixed()).toBe("4");
  });

  it("subtracts fees from sell proceeds", () => {
    const book = makeBook("token", [], [{ price: "0.25", size: "20" }]);
    const quote = quoteSell(book, "10", weatherFee);

    expect(quote.complete).toBe(true);
    expect(quote.netProceeds.lessThan(quote.notional)).toBe(true);
  });
});
