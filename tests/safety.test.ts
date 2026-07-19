import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StateDatabase } from "../src/persistence/database.js";
import type { AlertNotifier } from "../src/services/alerts.js";
import { LiveSafetyController } from "../src/services/safety.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LiveSafetyController", () => {
  it("persists an automatic kill switch across restarts and requires explicit clear", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-safety-"));
    temporaryDirectories.push(directory);
    const databasePath = path.join(directory, "state.sqlite");
    const sentinelPath = path.join(directory, "LIVE_TRADING_DISABLED");
    const send = vi.fn(async () => "delivered" as const);
    const alerts: AlertNotifier = { send };
    let state = new StateDatabase(databasePath);
    let safety = new LiveSafetyController(state, sentinelPath, alerts, pino({ enabled: false }));

    await safety.arm("test failure", { attemptId: "attempt-1" });
    expect(existsSync(sentinelPath)).toBe(true);
    await expect(safety.assertCanTrade()).rejects.toThrow("kill switch is armed");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ priority: 2 }));
    state.close();

    state = new StateDatabase(databasePath);
    safety = new LiveSafetyController(state, sentinelPath, alerts, pino({ enabled: false }));
    await expect(safety.isArmed()).resolves.toBe(true);
    await expect(safety.clear("wrong")).rejects.toThrow("CONFIRM");
    await safety.clear("CONFIRM");
    await expect(safety.isArmed()).resolves.toBe(false);
    expect(existsSync(sentinelPath)).toBe(false);
    state.close();
  });
});
