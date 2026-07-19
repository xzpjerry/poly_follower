import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "pino";

import { StateDatabase } from "../persistence/database.js";
import type { AlertNotifier } from "./alerts.js";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class LiveSafetyController {
  public constructor(
    private readonly state: StateDatabase,
    private readonly sentinelPath: string,
    private readonly alerts: AlertNotifier,
    private readonly logger: Logger,
  ) {}

  public async isArmed(): Promise<boolean> {
    return this.state.isKillSwitchArmed() || (await fileExists(this.sentinelPath));
  }

  public async assertCanTrade(): Promise<void> {
    if (await this.isArmed()) {
      throw new Error(`Live trading kill switch is armed at ${this.sentinelPath}`);
    }
  }

  public async arm(reason: string, details: Record<string, unknown> = {}): Promise<void> {
    const newlyArmed = this.state.armKillSwitch(reason);
    const temporaryPath = `${this.sentinelPath}.tmp`;
    try {
      await mkdir(path.dirname(this.sentinelPath), { recursive: true });
      await writeFile(
        temporaryPath,
        `${JSON.stringify({ armedAt: new Date().toISOString(), reason, details }, null, 2)}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      await rename(temporaryPath, this.sentinelPath);
    } catch (error) {
      this.logger.error({ error, sentinelPath: this.sentinelPath }, "Failed to persist kill-switch sentinel file");
    }

    this.logger.fatal({ reason, details, newlyArmed }, "Live trading kill switch armed");
    try {
      const detailText = Object.keys(details).length > 0 ? `\nDetails: ${JSON.stringify(details)}` : "";
      await this.alerts.send({
        dedupeKey: `kill-switch:${reason}`,
        title: "Polymarket follower stopped",
        message: `Live trading disabled: ${reason}${detailText}`,
        priority: 2,
      });
    } catch (error) {
      this.logger.error({ error }, "Kill switch is armed but Pushover delivery failed");
    }
  }

  public async clear(confirmation: string, reason = "manual operator reset"): Promise<void> {
    if (confirmation !== "CONFIRM") {
      throw new Error("Clearing the kill switch requires the exact confirmation CONFIRM");
    }
    this.state.clearKillSwitch(reason);
    try {
      await unlink(this.sentinelPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    this.logger.warn({ reason }, "Live trading kill switch cleared manually");
  }

  public async status(): Promise<{
    armed: boolean;
    databaseArmed: boolean;
    sentinelPresent: boolean;
    reason: string | null;
    updatedAt: string | null;
  }> {
    const database = this.state.getKillSwitchStatus();
    const sentinelPresent = await fileExists(this.sentinelPath);
    return {
      armed: database.armed || sentinelPresent,
      databaseArmed: database.armed,
      sentinelPresent,
      reason: database.reason,
      updatedAt: database.updatedAt,
    };
  }
}
