import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const originalEnvironment = { ...process.env };
const temporaryDirectories: string[] = [];

afterEach(() => {
  process.env = { ...originalEnvironment };
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeConfig(
  mode: string,
  follower: string | null,
  signatureType = 3,
  selector = '  event_slug: "event-slug"',
): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-config-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, "runtime.yaml");
  writeFileSync(
    filePath,
    `leader_profile_wallet: "0x1111111111111111111111111111111111111111"
follower_profile_wallet: ${follower === null ? "null" : `"${follower}"`}
simulate_empty_follower: ${follower === null ? "true" : "false"}
scope:
${selector}
  include_yes_tokens: true
  include_no_tokens: true
copy:
  share_ratio: "0.25"
  sync_existing_positions_on_start: true
risk:
  max_open_debit_usd: "5"
  max_event_loss_usd: "5"
monitoring: {}
execution:
  mode: "${mode}"
  signature_type: ${signatureType}
  max_orders_per_cycle: 1
alerts:
  pushover:
    enabled: true
state:
  database_path: "data/state.sqlite"
`,
  );
  return filePath;
}

describe("live configuration gates", () => {
  const follower = "0x2222222222222222222222222222222222222222";

  beforeEach(() => {
    process.env.PUSHOVER_APP_TOKEN_FILE = "/run/secrets/pushover_app_token";
    process.env.PUSHOVER_USER_KEY_FILE = "/run/secrets/pushover_user_key";
  });

  it("requires an exact event-slug confirmation for live mode", async () => {
    delete process.env.POLYMARKET_LIVE_TRADING_EVENT;
    await expect(loadConfig(writeConfig("live", follower))).rejects.toThrow(
      "POLYMARKET_LIVE_TRADING_EVENT",
    );
  });

  it("requires Pushover credential file paths in live mode", async () => {
    process.env.POLYMARKET_LIVE_TRADING_EVENT = "event-slug";
    delete process.env.PUSHOVER_USER_KEY_FILE;
    await expect(loadConfig(writeConfig("live", follower))).rejects.toThrow(
      "PUSHOVER_APP_TOKEN_FILE and PUSHOVER_USER_KEY_FILE",
    );
  });

  it("accepts live mode only when the event confirmation matches", async () => {
    process.env.POLYMARKET_LIVE_TRADING_EVENT = "event-slug";
    await expect(loadConfig(writeConfig("live", follower))).resolves.toMatchObject({
      execution: { mode: "live", signatureType: 3, maxOrdersPerCycle: 1 },
      followerProfileWallet: follower,
    });
  });

  it("rejects unsupported CLOB signature types", async () => {
    await expect(loadConfig(writeConfig("authenticated-readonly", follower, 4))).rejects.toThrow();
  });

  it("rejects authenticated mode without a follower wallet", async () => {
    await expect(loadConfig(writeConfig("authenticated-readonly", null))).rejects.toThrow(
      "require a follower profile wallet",
    );
  });

  it("accepts a unique Series and relative-date selector", async () => {
    delete process.env.POLYMARKET_LIVE_TRADING_EVENT;
    process.env.POLYMARKET_LIVE_TRADING_SERIES = "shenzhen-daily-weather";
    const configPath = writeConfig(
      "live",
      follower,
      3,
      '  series_slug: "shenzhen-daily-weather"\n  event_date: "today"\n  timezone: "Asia/Hong_Kong"',
    );
    await expect(loadConfig(configPath)).resolves.toMatchObject({
      scope: {
        eventSlug: null,
        seriesSlug: "shenzhen-daily-weather",
        eventDate: "today",
        timeZone: "Asia/Hong_Kong",
      },
    });
  });

  it("rejects a Series selector without an event date", async () => {
    await expect(
      loadConfig(
        writeConfig(
          "authenticated-readonly",
          follower,
          3,
          '  series_slug: "shenzhen-daily-weather"',
        ),
      ),
    ).rejects.toThrow("event_date");
  });
});
