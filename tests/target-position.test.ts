import { Decimal } from "decimal.js";
import { describe, expect, it } from "vitest";

import { buildReconciliationPlan, type TargetPlannerInput } from "../src/domain/target-position.js";
import type { PendingOrder } from "../src/domain/types.js";
import { makeAsset, makeBook, makeEvent, makePosition, noFee, weatherFee } from "./fixtures.js";

function baseInput(overrides: Partial<TargetPlannerInput> = {}): TargetPlannerInput {
  const asset = makeAsset();
  return {
    event: makeEvent([asset]),
    leaderPositions: [makePosition(asset.tokenId, "47", "0.29")],
    followerPositions: [],
    pendingOrders: [],
    books: new Map([[asset.tokenId, makeBook(asset.tokenId, [{ price: "0.29", size: "100" }])]]),
    copyRatio: "1",
    maxOpenDebit: "5",
    maxEventLoss: "5",
    realizedLoss: "0",
    maxPriceDriftAbs: "0.02",
    maxSlippageBps: 300,
    maxBookAgeMs: 2000,
    nowMs: Date.now(),
    allowBuys: true,
    unconfirmedLeaderZeroTokens: new Set(),
    ...overrides,
  };
}

describe("target position planning", () => {
  it("scales the observed 47-share weather trade to the all-in five dollar cap", () => {
    const plan = buildReconciliationPlan(baseInput());
    const decision = plan.decisions[0];

    expect(decision?.action).toBe("BUY");
    expect(new Decimal(plan.estimatedTargetRisk).lessThanOrEqualTo(5)).toBe(true);
    const expectedScale = new Decimal("5").div("14.113865");
    const actualScale = new Decimal(plan.capScale);
    expect(actualScale.lessThanOrEqualTo(expectedScale)).toBe(true);
    expect(expectedScale.minus(actualScale).lessThan("0.000001")).toBe(true);
    expect(new Decimal(decision?.targetSize ?? 0).minus("16.6502938776").abs().lessThan("0.000001")).toBe(true);
  });

  it("does not submit another order when confirmed holdings are already aligned", () => {
    const asset = makeAsset({ feeSchedule: noFee, minOrderSize: "0.1" });
    const input = baseInput({
      event: makeEvent([asset]),
      leaderPositions: [makePosition(asset.tokenId, "40", "0.25")],
      followerPositions: [makePosition(asset.tokenId, "10", "0.25")],
      books: new Map([[asset.tokenId, makeBook(asset.tokenId, [{ price: "0.25", size: "100" }])]]),
      copyRatio: "0.25",
    });

    const plan = buildReconciliationPlan(input);
    expect(plan.decisions[0]?.action).toBe("HOLD");
    expect(plan.decisions[0]?.reason).toBe("already_aligned");
  });

  it("counts pending buys toward effective holdings", () => {
    const asset = makeAsset({ feeSchedule: noFee, minOrderSize: "0.1" });
    const pending: PendingOrder = {
      orderId: "order-1",
      tokenId: asset.tokenId,
      side: "BUY",
      remainingShares: "10",
      reservedDebit: "2.5",
    };
    const plan = buildReconciliationPlan(
      baseInput({
        event: makeEvent([asset]),
        leaderPositions: [makePosition(asset.tokenId, "40", "0.25")],
        followerPositions: [],
        pendingOrders: [pending],
        books: new Map([[asset.tokenId, makeBook(asset.tokenId, [{ price: "0.25", size: "100" }])]]),
        copyRatio: "0.25",
      }),
    );

    expect(plan.decisions[0]?.action).toBe("HOLD");
    expect(plan.decisions[0]?.reason).toBe("already_aligned");
  });

  it("shares one event cap across multiple temperature markets", () => {
    const first = makeAsset({ tokenId: "token-30", marketSlug: "30c", feeSchedule: noFee, minOrderSize: "0.1" });
    const second = makeAsset({ tokenId: "token-32", marketSlug: "32c", feeSchedule: noFee, minOrderSize: "0.1" });
    const plan = buildReconciliationPlan(
      baseInput({
        event: makeEvent([first, second]),
        leaderPositions: [makePosition(first.tokenId, "20", "0.5"), makePosition(second.tokenId, "10", "0.5")],
        books: new Map([
          [first.tokenId, makeBook(first.tokenId, [{ price: "0.5", size: "100" }])],
          [second.tokenId, makeBook(second.tokenId, [{ price: "0.5", size: "100" }])],
        ]),
        copyRatio: "1",
      }),
    );

    const firstTarget = new Decimal(plan.decisions.find((item) => item.tokenId === first.tokenId)?.targetSize ?? 0);
    const secondTarget = new Decimal(plan.decisions.find((item) => item.tokenId === second.tokenId)?.targetSize ?? 0);
    expect(firstTarget.div(secondTarget).toFixed()).toBe("2");
    expect(new Decimal(plan.estimatedTargetRisk).lessThanOrEqualTo(5)).toBe(true);
  });

  it("plans a sell when the leader has exited and never exceeds confirmed shares", () => {
    const asset = makeAsset({ feeSchedule: weatherFee });
    const plan = buildReconciliationPlan(
      baseInput({
        event: makeEvent([asset]),
        leaderPositions: [],
        followerPositions: [makePosition(asset.tokenId, "10", "0.29")],
        books: new Map([[asset.tokenId, makeBook(asset.tokenId, [], [{ price: "0.25", size: "100" }])]]),
      }),
    );

    expect(plan.decisions[0]?.action).toBe("SELL");
    expect(new Decimal(plan.decisions[0]?.deltaSize ?? 0).abs().toFixed()).toBe("10");
  });

  it("suppresses a forced sell until a zero leader snapshot is confirmed", () => {
    const asset = makeAsset({ feeSchedule: weatherFee });
    const plan = buildReconciliationPlan(
      baseInput({
        event: makeEvent([asset]),
        leaderPositions: [],
        followerPositions: [makePosition(asset.tokenId, "10", "0.29")],
        books: new Map([[asset.tokenId, makeBook(asset.tokenId, [], [{ price: "0.25", size: "100" }])]]),
        unconfirmedLeaderZeroTokens: new Set([asset.tokenId]),
      }),
    );

    expect(plan.decisions[0]?.action).toBe("SKIP");
    expect(plan.decisions[0]?.reason).toBe("unconfirmed_leader_zero_snapshot");
  });

  it("reduces available risk by realized loss", () => {
    const plan = buildReconciliationPlan(baseInput({ realizedLoss: "2" }));
    expect(plan.availableRisk).toBe("3");
    expect(new Decimal(plan.estimatedTargetRisk).lessThanOrEqualTo(3)).toBe(true);
  });
});
