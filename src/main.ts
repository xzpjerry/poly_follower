import pino from "pino";

import { loadConfig, parseCliOptions } from "./config.js";
import { StateDatabase } from "./persistence/database.js";
import { ClobPublicClient } from "./polymarket/clob-public-client.js";
import { DataClient } from "./polymarket/data-client.js";
import { GammaClient } from "./polymarket/gamma-client.js";
import { JsonHttpClient } from "./polymarket/http-client.js";
import { Monitor } from "./services/monitor.js";
import { Reconciler } from "./services/reconciler.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "polymarket-weather-follower" },
});

async function main(): Promise<void> {
  const cli = parseCliOptions(process.argv.slice(2));
  const config = await loadConfig(cli.configPath);
  if (config.execution.mode !== "dry-run") {
    throw new Error("Only dry-run execution is implemented");
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
  const reconciler = new Reconciler(config, gamma, data, clob, state, logger);

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
