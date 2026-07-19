import pino from "pino";

import { loadConfig, parseCliOptions } from "./config.js";
import { StateDatabase } from "./persistence/database.js";
import { AuthenticatedClobClient } from "./polymarket/clob-authenticated-client.js";
import { ClobPublicClient } from "./polymarket/clob-public-client.js";
import { DataClient } from "./polymarket/data-client.js";
import { GammaClient } from "./polymarket/gamma-client.js";
import { JsonHttpClient } from "./polymarket/http-client.js";
import { loadTradingCredentials } from "./security/credentials.js";
import { Monitor } from "./services/monitor.js";
import { Reconciler } from "./services/reconciler.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "polymarket-weather-follower" },
  redact: {
    paths: [
      "privateKey",
      "secret",
      "passphrase",
      "apiKey",
      "POLY_SIGNATURE",
      "POLY_API_KEY",
      "POLY_PASSPHRASE",
    ],
    censor: "[REDACTED]",
  },
  serializers: {
    error: (error: unknown) =>
      error instanceof Error
        ? { type: error.name, message: error.message, stack: error.stack }
        : { type: "UnknownError", message: String(error) },
  },
});

async function main(): Promise<void> {
  const cli = parseCliOptions(process.argv.slice(2));
  const config = await loadConfig(cli.configPath);
  let authenticatedClob: AuthenticatedClobClient | null = null;
  if (config.execution.mode !== "dry-run") {
    if (!config.followerProfileWallet) {
      throw new Error("Authenticated execution requires a follower profile wallet");
    }
    const credentials = await loadTradingCredentials();
    authenticatedClob = await AuthenticatedClobClient.connect(
      credentials,
      config.followerProfileWallet,
      config.execution.signatureType,
      logger,
    );
    const accountStatus = await authenticatedClob.getAccountStatus();
    logger.info(accountStatus, "Authenticated CLOB identity, balance, and signature type verified");
    if (config.execution.mode === "live" && accountStatus.closedOnly) {
      throw new Error("CLOB account is in closed-only mode; live execution is disabled");
    }
  }

  const state = new StateDatabase(config.state.databasePath);
  const gammaHttp = new JsonHttpClient(
    "https://gamma-api.polymarket.com",
    config.monitoring.requestTimeoutMs,
    logger,
  );
  const dataHttp = new JsonHttpClient(
    "https://data-api.polymarket.com",
    config.monitoring.requestTimeoutMs,
    logger,
  );
  const clobHttp = new JsonHttpClient("https://clob.polymarket.com", config.monitoring.requestTimeoutMs, logger);
  const gamma = new GammaClient(gammaHttp);
  const data = new DataClient(dataHttp);
  const clob = new ClobPublicClient(clobHttp);
  const reconciler = new Reconciler(config, gamma, data, clob, state, logger, authenticatedClob);

  try {
    if (cli.once) {
      await reconciler.runOnce();
      return;
    }

    const abortController = new AbortController();
    const stop = (signal: string): void => {
      logger.info({ signal }, "Shutdown requested");
      abortController.abort();
    };
    process.once("SIGINT", () => stop("SIGINT"));
    process.once("SIGTERM", () => stop("SIGTERM"));

    const monitor = new Monitor(config, data, state, reconciler, logger);
    await monitor.run(abortController.signal);
  } finally {
    state.close();
  }
}

main().catch((error: unknown) => {
  logger.fatal({ error }, "Application failed");
  process.exitCode = 1;
});
