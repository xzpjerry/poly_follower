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
});
