import { describe, expect, it } from "vitest";

import { compareLedgerToPublicPositions, reconstructEventLedger } from "../src/domain/trade-ledger.js";
import type { FollowerTrade } from "../src/domain/types.js";
import { makeAsset, makePosition } from "./fixtures.js";

function trade(overrides: Partial<FollowerTrade> = {}): FollowerTrade {
  return {
    tradeId: "trade-1",
    tokenId: "token-yes",
    side: "BUY",
    size: "10",
    price: "0.4",
    traderSide: "TAKER",
    matchedAt: "2026-07-19T01:00:00Z",
    status: "CONFIRMED",
    orderIds: ["order-1"],
    transactionHash: "0xtransaction",
    raw: {},
    ...overrides,
  };
}

describe("reconstructEventLedger", () => {
  it("reconstructs holdings and cumulative realized losses", () => {
    const asset = makeAsset({ tokenId: "token-yes" });
    const ledger = reconstructEventLedger(
      [
        trade(),
        trade({
          tradeId: "trade-2",
          side: "SELL",
          size: "4",
          price: "0.2",
          matchedAt: "2026-07-19T02:00:00Z",
        }),
      ],
      [asset],
    );

    expect(ledger.sizes.get("token-yes")).toBe("6");
    expect(Number(ledger.realizedLoss)).toBeGreaterThan(0);
    expect(ledger.tradeCount).toBe(2);
  });

  it("deduplicates repeated authenticated trade pages", () => {
    const item = trade();
    const ledger = reconstructEventLedger([item, item], [makeAsset({ tokenId: "token-yes" })]);
    expect(ledger.sizes.get("token-yes")).toBe("10");
    expect(ledger.tradeCount).toBe(1);
  });

  it("does not apply FAILED trades to reconstructed positions", () => {
    const ledger = reconstructEventLedger(
      [trade({ status: "FAILED" })],
      [makeAsset({ tokenId: "token-yes" })],
    );
    expect(ledger.sizes.get("token-yes") ?? "0").toBe("0");
    expect(ledger.tradeCount).toBe(0);
  });

  it("detects disagreement with the public position snapshot", () => {
    const ledger = reconstructEventLedger([trade()], [makeAsset({ tokenId: "token-yes" })]);
    const mismatches = compareLedgerToPublicPositions(
      ledger,
      [makePosition("token-yes", "9")],
      ["token-yes"],
    );
    expect(mismatches).toEqual([{ tokenId: "token-yes", publicSize: "9", reconstructedSize: "10" }]);
  });
});
