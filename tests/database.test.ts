import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { UserActivity } from "../src/domain/types.js";
import { StateDatabase } from "../src/persistence/database.js";
import { makePosition } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("StateDatabase", () => {
  it("deduplicates repeated activity observations", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    const activity: UserActivity = {
      proxyWallet: "0x1111111111111111111111111111111111111111",
      timestamp: 1784298279,
      conditionId: "0xcondition",
      type: "TRADE",
      size: "47",
      usdcSize: "14.11386",
      transactionHash: "0xtransaction",
      price: "0.29",
      tokenId: "token",
      side: "BUY",
      outcome: "Yes",
      marketSlug: "32c",
      eventSlug: "event",
      raw: {},
    };

    expect(state.insertActivity("event-123", activity.proxyWallet, [activity])).toBe(1);
    expect(state.insertActivity("event-123", activity.proxyWallet, [activity])).toBe(0);
    state.close();
  });

  it("requires two consecutive zero snapshots before confirming an exit", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    const wallet = "0x1111111111111111111111111111111111111111";

    expect(state.observeLeaderPositions("event-123", wallet, ["token"], [])).toEqual(new Set(["token"]));
    expect(state.observeLeaderPositions("event-123", wallet, ["token"], [])).toEqual(new Set());
    expect(state.observeLeaderPositions("event-123", wallet, ["token"], [makePosition("token", "5")])).toEqual(
      new Set(),
    );
    expect(state.observeLeaderPositions("event-123", wallet, ["token"], [])).toEqual(new Set(["token"]));
    state.close();
  });

  it("replaces authenticated open-order snapshots authoritatively", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    state.replaceOpenOrders("event-123", [
      {
        orderId: "order-1",
        tokenId: "token",
        side: "BUY",
        remainingShares: "5",
        reservedDebit: "2",
      },
    ]);
    expect(state.getOpenOrders("event-123")).toHaveLength(1);

    state.replaceOpenOrders("event-123", []);
    expect(state.getOpenOrders("event-123")).toEqual([]);
    state.close();
  });

  it("updates reconstructed realized loss", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    state.setRealizedLoss("event-123", "0x1111111111111111111111111111111111111111", "1.25");
    expect(state.getRealizedLoss("event-123", "0x1111111111111111111111111111111111111111")).toBe("1.25");
    state.close();
  });

  it("keeps accepted and matched attempts fail-closed until a terminal trade state", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    state.beginExecutionAttempt({
      attemptId: "attempt-1",
      runId: "run-1",
      eventId: "event-123",
      tokenId: "token",
      side: "BUY",
      requestedShares: "5",
      expectedDebit: "2",
    });
    expect(state.hasUnresolvedExecutionAttempt("event-123")).toBe(true);
    state.acceptExecutionAttempt("attempt-1", "order-1", { status: "matched" }, ["trade-1"]);
    expect(state.hasUnresolvedExecutionAttempt("event-123")).toBe(true);
    state.recordTradeLifecycle({
      eventId: "event-123",
      tradeId: "trade-1",
      status: "MATCHED",
      orderIds: ["order-1"],
      transactionHash: null,
      source: "user-websocket",
      raw: {},
    });
    expect(state.hasUnresolvedExecutionAttempt("event-123")).toBe(true);
    state.recordTradeLifecycle({
      eventId: "event-123",
      tradeId: "trade-1",
      status: "CONFIRMED",
      orderIds: [],
      transactionHash: "0xtransaction",
      source: "authenticated-poll",
      raw: {},
    });
    expect(state.hasUnresolvedExecutionAttempt("event-123")).toBe(false);
    expect(state.getExecutionAttemptState("attempt-1")).toBe("confirmed");
    expect(
      state.recordTradeLifecycle({
        eventId: "event-123",
        tradeId: "trade-1",
        status: "FAILED",
        orderIds: ["order-1"],
        transactionHash: null,
        source: "user-websocket",
        raw: {},
      }),
    ).toBe(0);
    expect(state.getExecutionAttemptState("attempt-1")).toBe("confirmed");
    state.close();
  });

  it("treats an authenticated order cancellation as terminal", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    state.beginExecutionAttempt({
      attemptId: "attempt-cancelled",
      runId: "run-1",
      eventId: "event-123",
      tokenId: "token",
      side: "BUY",
      requestedShares: "5",
      expectedDebit: "2",
    });
    state.acceptExecutionAttempt("attempt-cancelled", "order-cancelled", { status: "matched" });
    expect(
      state.recordUserOrderUpdate({
        eventId: "event-123",
        orderId: "order-cancelled",
        tokenId: "token",
        type: "CANCELLATION",
        sizeMatched: "0",
        originalSize: "5",
        source: "user-websocket",
        raw: {},
      }),
    ).toBe(1);
    expect(state.hasUnresolvedExecutionAttempt("event-123")).toBe(false);
    expect(state.getExecutionAttemptState("attempt-cancelled")).toBe("cancelled");
    state.close();
  });
});
