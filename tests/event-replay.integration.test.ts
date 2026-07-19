import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Decimal } from "decimal.js";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  DiscoveredEvent,
  FollowerTrade,
  ReconciliationDecision,
  TrackedAsset,
  UserActivity,
  UserPosition,
} from "../src/domain/types.js";
import { StateDatabase } from "../src/persistence/database.js";
import type { ExecutionReceipt } from "../src/polymarket/clob-authenticated-client.js";
import type { ClobApiCredentials } from "../src/security/credentials.js";
import type { AlertNotifier } from "../src/services/alerts.js";
import type { AuthenticatedClobPort, ClobPublicPort, DataPort, GammaPort } from "../src/services/ports.js";
import { Reconciler } from "../src/services/reconciler.js";
import { LiveSafetyController } from "../src/services/safety.js";
import { makeAsset, makeBook, makeConfig, makeEvent, makePosition, noFee } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class ReplayAccount implements DataPort, AuthenticatedClobPort {
  public leaderPositions: UserPosition[] = [];
  public followerPositions: UserPosition[] = [];
  public trades: FollowerTrade[] = [];
  public executionCount = 0;
  public preflightError: Error | null = null;
  public executionError: Error | null = null;
  public nextTradeStatus: FollowerTrade["status"] = "CONFIRMED";
  public readonly funderAddress = "0x2222222222222222222222222222222222222222";

  public async getPositions(user: string, _eventId: string): Promise<UserPosition[]> {
    return user.toLowerCase() === this.funderAddress ? this.followerPositions : this.leaderPositions;
  }

  public async getActivity(_user: string, _eventId: string, _startTimestamp: number): Promise<UserActivity[]> {
    return [];
  }

  public async getOpenOrders(): Promise<[]> {
    return [];
  }

  public async getTrades(): Promise<FollowerTrade[]> {
    return this.trades;
  }

  public async preflightFok(_decision: ReconciliationDecision): Promise<void> {
    if (this.preflightError) {
      throw this.preflightError;
    }
  }

  public async executeFok(decision: ReconciliationDecision, _asset: TrackedAsset): Promise<ExecutionReceipt> {
    this.executionCount += 1;
    if (this.executionError) {
      throw this.executionError;
    }
    const sequence = this.executionCount;
    const orderId = `order-${sequence}`;
    const tradeId = `trade-${sequence}`;
    const side = decision.action as "BUY" | "SELL";
    const shares = new Decimal(decision.deltaSize).abs();
    if (this.nextTradeStatus !== "FAILED") {
      const current = this.followerPositions.find((position) => position.tokenId === decision.tokenId);
      const nextSize = side === "BUY"
        ? new Decimal(current?.size ?? 0).plus(shares)
        : Decimal.max(0, new Decimal(current?.size ?? 0).minus(shares));
      this.followerPositions = this.followerPositions.filter((position) => position.tokenId !== decision.tokenId);
      if (nextSize.greaterThan(0)) {
        this.followerPositions.push({
          ...makePosition(decision.tokenId, nextSize.toFixed(), decision.worstPrice ?? "0"),
          proxyWallet: this.funderAddress,
        });
      }
    }
    this.trades.push({
      tradeId,
      tokenId: decision.tokenId,
      side,
      size: shares.toFixed(),
      price: decision.worstPrice ?? "0",
      traderSide: "TAKER",
      matchedAt: new Date(Date.UTC(2026, 6, 19, 1, sequence)).toISOString(),
      status: this.nextTradeStatus,
      orderIds: [orderId],
      transactionHash: this.nextTradeStatus === "CONFIRMED" ? `0xtx${sequence}` : null,
      raw: {},
    });
    return {
      orderId,
      status: "matched",
      takingAmount: shares.toFixed(),
      makingAmount: decision.estimatedDebit,
      tradeIds: [tradeId],
      transactionHashes: [],
    };
  }

  public getUserWebSocketAuth(): ClobApiCredentials {
    return { key: "key", secret: "secret", passphrase: "passphrase" };
  }
}

function replayFixture(): { event: DiscoveredEvent; first: TrackedAsset; second: TrackedAsset } {
  const first = makeAsset({
    tokenId: "token-31",
    conditionId: "0xcondition-31",
    marketSlug: "31c",
    minOrderSize: "0.1",
    feeSchedule: noFee,
  });
  const second = makeAsset({
    tokenId: "token-32",
    conditionId: "0xcondition-32",
    marketSlug: "32c",
    minOrderSize: "0.1",
    feeSchedule: noFee,
  });
  return { event: makeEvent([first, second]), first, second };
}

function makeHarness(
  directory: string,
  account: ReplayAccount,
  state: StateDatabase,
  send = vi.fn(async (_alert: Parameters<AlertNotifier["send"]>[0]) => "delivered" as const),
) {
  const { event, first, second } = replayFixture();
  state.upsertEvent(event);
  const gamma: GammaPort = {
    getEventBySlug: async () => event,
    getEventBySeriesDate: async () => event,
  };
  const clob: ClobPublicPort = {
    getOrderBook: async (tokenId) => {
      const price = tokenId === first.tokenId ? "0.25" : "0.5";
      return makeBook(tokenId, [{ price, size: "1000" }], [{ price, size: "1000" }]);
    },
  };
  const config = makeConfig({
    execution: { mode: "live" },
    safety: { killSwitchPath: path.join(directory, "LIVE_TRADING_DISABLED") },
    state: { databasePath: path.join(directory, "state.sqlite") },
  });
  const alerts: AlertNotifier = { send };
  const safety = new LiveSafetyController(state, config.safety.killSwitchPath, alerts, pino({ enabled: false }));
  const reconciler = new Reconciler(
    config,
    gamma,
    account,
    clob,
    state,
    pino({ enabled: false }),
    account,
    safety,
    alerts,
    { isHealthy: () => true },
  );
  return { event, first, second, safety, reconciler, send };
}

describe("full Event replay through Mock CLOB", () => {
  it("replays two temperature markets, exits safely, and remains idempotent after restart", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-replay-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "state.sqlite");
    const account = new ReplayAccount();
    let state = new StateDatabase(databasePath);
    let harness = makeHarness(directory, account, state);

    account.leaderPositions = [makePosition(harness.first.tokenId, "40", "0.25")];
    const plans = [await harness.reconciler.runOnce(harness.event)];
    expect(account.executionCount).toBe(1);
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Polymarket order accepted",
        message: expect.stringMatching(/Attempt: .+\nOrder: order-1/),
        priority: 1,
      }),
    );
    plans.push(await harness.reconciler.runOnce(harness.event));
    expect(account.executionCount).toBe(1);

    account.leaderPositions = [
      makePosition(harness.first.tokenId, "40", "0.25"),
      makePosition(harness.second.tokenId, "20", "0.5"),
    ];
    plans.push(await harness.reconciler.runOnce(harness.event));
    expect(account.executionCount).toBe(2);
    plans.push(await harness.reconciler.runOnce(harness.event));

    account.leaderPositions = [makePosition(harness.second.tokenId, "20", "0.5")];
    const firstZero = await harness.reconciler.runOnce(harness.event);
    expect(firstZero.decisions.find((decision) => decision.tokenId === harness.first.tokenId)?.reason).toBe(
      "unconfirmed_leader_zero_snapshot",
    );
    expect(account.executionCount).toBe(2);
    plans.push(firstZero, await harness.reconciler.runOnce(harness.event));
    expect(account.executionCount).toBe(3);
    plans.push(await harness.reconciler.runOnce(harness.event));

    for (const plan of plans) {
      expect(new Decimal(plan.estimatedTargetRisk).lessThanOrEqualTo(5)).toBe(true);
    }

    state.close();
    state = new StateDatabase(databasePath);
    harness = makeHarness(directory, account, state);
    await harness.reconciler.runOnce(harness.event);
    expect(account.executionCount).toBe(3);
    expect(account.followerPositions.map((position) => position.tokenId)).toEqual([harness.second.tokenId]);
    state.close();
  });

  it("blocks duplicates while MATCHED and automatically kills an ambiguous submission", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-fault-"));
    temporaryDirectories.push(directory);
    const account = new ReplayAccount();
    account.nextTradeStatus = "MATCHED";
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    const harness = makeHarness(directory, account, state);
    account.leaderPositions = [makePosition(harness.first.tokenId, "40", "0.25")];

    await harness.reconciler.runOnce(harness.event);
    await harness.reconciler.runOnce(harness.event);
    expect(account.executionCount).toBe(1);
    expect(state.hasUnresolvedExecutionAttempt(harness.event.eventId)).toBe(true);

    account.trades[0] = { ...account.trades[0]!, status: "CONFIRMED", transactionHash: "0xtx" };
    await harness.reconciler.runOnce(harness.event);
    expect(state.hasUnresolvedExecutionAttempt(harness.event.eventId)).toBe(false);

    account.leaderPositions = [
      makePosition(harness.first.tokenId, "40", "0.25"),
      makePosition(harness.second.tokenId, "20", "0.5"),
    ];
    account.executionError = new Error("simulated transport loss after submit");
    await expect(harness.reconciler.runOnce(harness.event)).rejects.toThrow("simulated transport loss");
    await expect(harness.safety.isArmed()).resolves.toBe(true);
    expect(state.hasUnresolvedExecutionAttempt(harness.event.eventId)).toBe(true);
    state.close();
  });

  it("fails preflight without creating an execution intent", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-preflight-"));
    temporaryDirectories.push(directory);
    const account = new ReplayAccount();
    account.preflightError = new Error("insufficient allowance");
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    const harness = makeHarness(directory, account, state);
    account.leaderPositions = [makePosition(harness.first.tokenId, "40", "0.25")];

    await harness.reconciler.runOnce(harness.event);
    expect(account.executionCount).toBe(0);
    expect(state.hasUnresolvedExecutionAttempt(harness.event.eventId)).toBe(false);
    expect(harness.send).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Polymarket order preflight failed",
        message: expect.stringContaining("Reason: insufficient allowance"),
        priority: 1,
      }),
    );
    await expect(harness.safety.isArmed()).resolves.toBe(false);
    state.close();
  });

  it("does not call the CLOB when the pre-submission audit notification fails", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-intent-alert-failure-"));
    temporaryDirectories.push(directory);
    const account = new ReplayAccount();
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    const send = vi.fn(async (alert: Parameters<AlertNotifier["send"]>[0]) => {
      if (alert.title === "Polymarket order submitting") {
        throw new Error("simulated Pushover outage");
      }
      return "delivered" as const;
    });
    const harness = makeHarness(directory, account, state, send);
    account.leaderPositions = [makePosition(harness.first.tokenId, "40", "0.25")];

    await harness.reconciler.runOnce(harness.event);

    expect(account.executionCount).toBe(0);
    expect(state.hasUnresolvedExecutionAttempt(harness.event.eventId)).toBe(false);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("order intent notification failed"),
        priority: 2,
      }),
    );
    await expect(harness.safety.isArmed()).resolves.toBe(true);
    state.close();
  });

  it("arms the persistent kill switch when polling recovers a FAILED trade", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-failed-trade-"));
    temporaryDirectories.push(directory);
    const account = new ReplayAccount();
    account.nextTradeStatus = "FAILED";
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    const harness = makeHarness(directory, account, state);
    account.leaderPositions = [makePosition(harness.first.tokenId, "40", "0.25")];

    await harness.reconciler.runOnce(harness.event);
    await expect(harness.reconciler.runOnce(harness.event)).rejects.toThrow("kill switch is armed");
    await expect(harness.safety.isArmed()).resolves.toBe(true);
    expect(state.hasUnresolvedExecutionAttempt(harness.event.eventId)).toBe(false);
    state.close();
  });

  it("stops live trading and sends attempt identifiers after a 180-second terminal timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-19T01:00:00.000Z"));
      const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-terminal-timeout-"));
      temporaryDirectories.push(directory);
      const account = new ReplayAccount();
      const state = new StateDatabase(path.join(directory, "state.sqlite"));
      const harness = makeHarness(directory, account, state);
      state.beginExecutionAttempt({
        attemptId: "attempt-over-180-seconds",
        runId: "run-old",
        eventId: harness.event.eventId,
        tokenId: harness.first.tokenId,
        side: "BUY",
        requestedShares: "10",
        expectedDebit: "2.5",
      });

      vi.advanceTimersByTime(181_000);
      await harness.reconciler.runOnce(harness.event);

      await expect(harness.safety.isArmed()).resolves.toBe(true);
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Polymarket follower stopped",
          message: expect.stringContaining("attempt-over-180-seconds"),
          priority: 2,
        }),
      );
      expect(account.executionCount).toBe(0);
      state.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
