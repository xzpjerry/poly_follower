import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadPushoverCredentials, loadTradingCredentials } from "../src/security/credentials.js";

const originalEnvironment = { ...process.env };
const temporaryDirectories: string[] = [];

afterEach(() => {
  process.env = { ...originalEnvironment };
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function secretFile(name: string, contents: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-credentials-"));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, name);
  writeFileSync(filePath, `${contents}\n`, { mode: 0o600 });
  return filePath;
}

describe("loadTradingCredentials", () => {
  it("loads and trims file-backed credentials", async () => {
    process.env.POLYMARKET_PRIVATE_KEY_FILE = secretFile("private-key", `0x${"11".repeat(32)}`);
    process.env.POLYMARKET_CLOB_API_KEY_FILE = secretFile("api-key", "key");
    process.env.POLYMARKET_CLOB_API_SECRET_FILE = secretFile("api-secret", "secret");
    process.env.POLYMARKET_CLOB_API_PASSPHRASE_FILE = secretFile("passphrase", "passphrase");

    await expect(loadTradingCredentials()).resolves.toEqual({
      privateKey: `0x${"11".repeat(32)}`,
      clob: { key: "key", secret: "secret", passphrase: "passphrase" },
    });
  });

  it("allows CLOB credentials to be derived in memory", async () => {
    process.env.POLYMARKET_PRIVATE_KEY_FILE = secretFile("private-key", `0x${"22".repeat(32)}`);

    await expect(loadTradingCredentials()).resolves.toEqual({
      privateKey: `0x${"22".repeat(32)}`,
      clob: null,
    });
  });

  it("rejects a partial CLOB credential set", async () => {
    process.env.POLYMARKET_PRIVATE_KEY_FILE = secretFile("private-key", `0x${"33".repeat(32)}`);
    process.env.POLYMARKET_CLOB_API_KEY_FILE = secretFile("api-key", "key");

    await expect(loadTradingCredentials()).rejects.toThrow("complete key/secret/passphrase set");
  });
});

describe("loadPushoverCredentials", () => {
  it("loads Pushover secrets only from file paths", async () => {
    process.env.PUSHOVER_APP_TOKEN_FILE = secretFile("pushover-app-token", "app-token");
    process.env.PUSHOVER_USER_KEY_FILE = secretFile("pushover-user-key", "user-key");

    await expect(loadPushoverCredentials()).resolves.toEqual({
      applicationToken: "app-token",
      userKey: "user-key",
    });
  });
});
