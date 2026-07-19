import pino from "pino";

import { loadConfig, parseCliOptions } from "./config.js";
import { StateDatabase } from "./persistence/database.js";
import { loadPushoverCredentials } from "./security/credentials.js";
import { NoopAlertNotifier, PushoverNotifier, type AlertNotifier } from "./services/alerts.js";
import { LiveSafetyController } from "./services/safety.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "polymarket-weather-follower-kill-switch" },
  redact: {
    paths: ["applicationToken", "userKey", "secret", "passphrase", "apiKey"],
    censor: "[REDACTED]",
  },
});

function getCommand(argv: string[]): "arm" | "status" | "clear" {
  const command = argv.find((argument) => ["arm", "status", "clear"].includes(argument));
  if (command !== "arm" && command !== "status" && command !== "clear") {
    throw new Error("Usage: kill-switch <arm|status|clear> [--reason text] [--confirm] [--config path]");
  }
  return command;
}

function getOption(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0) {
    return null;
  }
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = getCommand(argv);
  const config = await loadConfig(parseCliOptions(argv).configPath);
  const state = new StateDatabase(config.state.databasePath);
  try {
    let alerts: AlertNotifier = new NoopAlertNotifier();
    if (command === "arm" && config.alerts.pushover.enabled) {
      alerts = new PushoverNotifier(
        await loadPushoverCredentials(),
        config.alerts.pushover,
        state,
        logger,
      );
    }
    const safety = new LiveSafetyController(state, config.safety.killSwitchPath, alerts, logger);
    if (command === "arm") {
      await safety.arm(getOption(argv, "--reason") ?? "manual operator stop");
    } else if (command === "clear") {
      await safety.clear(argv.includes("--confirm") ? "CONFIRM" : "", getOption(argv, "--reason") ?? undefined);
    }
    process.stdout.write(`${JSON.stringify(await safety.status(), null, 2)}\n`);
  } finally {
    state.close();
  }
}

main().catch((error: unknown) => {
  logger.fatal({ error }, "Kill-switch command failed");
  process.exitCode = 1;
});
