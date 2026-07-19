import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import type { DiscoveredEvent } from "../domain/types.js";
import { StateDatabase } from "../persistence/database.js";
import { Reconciler } from "./reconciler.js";
import type { DataPort } from "./ports.js";
import { UserStream } from "./user-stream.js";

function sleep(durationMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, durationMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export class Monitor {
  public constructor(
    private readonly config: AppConfig,
    private readonly data: DataPort,
    private readonly state: StateDatabase,
    private readonly reconciler: Reconciler,
    private readonly logger: Logger,
    private readonly userStream: UserStream | null = null,
  ) {}

  public async run(signal: AbortSignal): Promise<void> {
    let event = await this.reconciler.discover();
    this.userStream?.setEvent(event);
    const userStreamTask = this.userStream?.run(signal);

    try {
      await this.reconciler.runOnce(event);
      let lastFullReconcileMs = Date.now();

      while (!signal.aborted) {
        try {
          const storedCursor = this.state.getCursor(
            "leader_activity",
            this.config.leaderProfileWallet,
            event.eventId,
          );
          const currentSeconds = Math.floor(Date.now() / 1000);
          const cursor = storedCursor ?? currentSeconds;
          const start = Math.max(0, cursor - this.config.monitoring.activityOverlapSeconds);
          const activity = await this.data.getActivity(
            this.config.leaderProfileWallet,
            event.eventId,
            start,
          );
          const inserted = this.state.insertActivity(
            event.eventId,
            this.config.leaderProfileWallet,
            activity,
          );
          const latestTimestamp = activity.reduce(
            (latest, item) => Math.max(latest, item.timestamp),
            cursor,
          );
          this.state.setCursor(
            "leader_activity",
            this.config.leaderProfileWallet,
            event.eventId,
            latestTimestamp,
          );

          const fullDue =
            Date.now() - lastFullReconcileMs >=
            this.config.monitoring.fullReconcileSeconds * 1000;
          if (inserted > 0 || fullDue) {
            if (fullDue) {
              event = await this.reconciler.discover();
              this.userStream?.setEvent(event);
            }
            await this.reconciler.runOnce(event);
            lastFullReconcileMs = Date.now();
          }
        } catch (error) {
          this.logger.error({ error }, "Monitor iteration failed closed");
        }

        await sleep(this.config.monitoring.activityPollMs, signal);
      }
    } finally {
      await userStreamTask;
    }
  }
}
