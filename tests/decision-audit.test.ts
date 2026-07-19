import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReconciliationPlan } from "../src/domain/types.js";
import { StateDatabase } from "../src/persistence/database.js";
import type { AlertMessage, AlertNotifier } from "../src/services/alerts.js";
import { notifyDecisionChanges } from "../src/services/decision-audit.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makePlan(runId: string, firstAction: "BUY" | "SKIP" | "HOLD" = "BUY"): ReconciliationPlan {
  return {
    runId,
    eventId: "event-123",
    eventSlug: "highest-temperature-in-shenzhen-on-july-19-2026",
    copyRatio: "0.25",
    capScale: "1",
    maxEventRisk: "5",
    realizedLoss: "0",
    availableRisk: "5",
    estimatedTargetRisk: "2.5",
    createdAt: "2026-07-19T00:00:00.000Z",
    decisions: [
      {
        tokenId: "token-31",
        marketSlug: "highest-temperature-in-shenzhen-on-july-19-2026-31c",
        outcome: "Yes",
        action: firstAction,
        leaderSize: "40",
        rawTargetSize: "10",
        targetSize: "10",
        confirmedSize: "0",
        effectiveSize: "0",
        deltaSize: firstAction === "BUY" ? "10" : "0",
        estimatedDebit: firstAction === "BUY" ? "2.5" : "0",
        estimatedProceeds: "0",
        worstPrice: firstAction === "BUY" ? "0.25" : null,
        reason: firstAction === "BUY" ? "target_above_effective_position" : "test_reason",
      },
      {
        tokenId: "token-32",
        marketSlug: "highest-temperature-in-shenzhen-on-july-19-2026-32c",
        outcome: "Yes",
        action: "HOLD",
        leaderSize: "0",
        rawTargetSize: "0",
        targetSize: "0",
        confirmedSize: "0",
        effectiveSize: "0",
        deltaSize: "0",
        estimatedDebit: "0",
        estimatedProceeds: "0",
        worstPrice: null,
        reason: "target_matches_effective_position",
      },
    ],
  };
}

describe("decision audit notifications", () => {
  it("notifies changed actionable decisions and suppresses identical cycles and initial HOLD", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-decision-audit-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    const delivered: AlertMessage[] = [];
    const alerts: AlertNotifier = {
      send: vi.fn(async (alert) => {
        delivered.push(alert);
        return "delivered" as const;
      }),
    };

    await expect(notifyDecisionChanges(state, alerts, makePlan("run-1"), "authenticated-readonly")).resolves.toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toEqual(
      expect.objectContaining({
        title: "[authenticated-readonly] BUY 31c Yes",
        priority: 0,
      }),
    );
    expect(delivered[0]?.message).toContain("Event risk: 2.5 / 5");
    expect(delivered[0]?.message).toContain("Copy/cap scale: 0.25 / 1");
    expect(delivered[0]?.message).toContain("Leader/target: 40 / 10");

    await expect(notifyDecisionChanges(state, alerts, makePlan("run-2"), "authenticated-readonly")).resolves.toBe(0);
    expect(delivered).toHaveLength(1);

    await expect(notifyDecisionChanges(state, alerts, makePlan("run-3", "SKIP"), "authenticated-readonly")).resolves.toBe(1);
    expect(delivered.at(-1)?.title).toBe("[authenticated-readonly] SKIP 31c Yes");

    await expect(notifyDecisionChanges(state, alerts, makePlan("run-4", "HOLD"), "authenticated-readonly")).resolves.toBe(1);
    expect(delivered.at(-1)?.title).toBe("[authenticated-readonly] HOLD 31c Yes");
    state.close();
  });

  it("raises an actionable BUY decision to priority 1 in live mode", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-decision-live-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    const send = vi.fn(async (_alert: AlertMessage) => "delivered" as const);

    await notifyDecisionChanges(state, { send }, makePlan("run-live"), "live");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ priority: 1 }));
    state.close();
  });
});
