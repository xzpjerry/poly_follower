import { randomUUID } from "node:crypto";

import type { Logger } from "pino";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import { StateDatabase } from "../persistence/database.js";
import type { PushoverCredentials } from "../security/credentials.js";

const pushoverResponseSchema = z.object({
  status: z.number(),
  request: z.string().optional(),
  receipt: z.string().optional(),
});
const PUSHOVER_TITLE_LIMIT = 250;
const PUSHOVER_MESSAGE_LIMIT = 1024;

function truncateCodePoints(value: string, limit: number): string {
  const points = [...value];
  if (points.length <= limit) {
    return value;
  }
  return `${points.slice(0, Math.max(0, limit - 1)).join("")}…`;
}

export type AlertPriority = -2 | -1 | 0 | 1 | 2;

export interface AlertMessage {
  dedupeKey: string;
  title: string;
  message: string;
  priority: AlertPriority;
}

export interface AlertNotifier {
  send(alert: AlertMessage): Promise<"delivered" | "deduplicated">;
}

export class NoopAlertNotifier implements AlertNotifier {
  public async send(_alert: AlertMessage): Promise<"deduplicated"> {
    return "deduplicated";
  }
}

export class PushoverNotifier implements AlertNotifier {
  public constructor(
    private readonly credentials: PushoverCredentials,
    private readonly config: AppConfig["alerts"]["pushover"],
    private readonly state: StateDatabase,
    private readonly logger: Logger,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  public async send(alert: AlertMessage): Promise<"delivered" | "deduplicated"> {
    const normalizedAlert: AlertMessage = {
      ...alert,
      title: truncateCodePoints(alert.title, PUSHOVER_TITLE_LIMIT),
      message: truncateCodePoints(alert.message, PUSHOVER_MESSAGE_LIMIT),
    };
    const since = new Date(Date.now() - this.config.dedupeSeconds * 1000).toISOString();
    if (this.state.wasAlertDeliveredSince(normalizedAlert.dedupeKey, since)) {
      this.logger.info(
        { dedupeKey: normalizedAlert.dedupeKey },
        "Pushover alert suppressed by deduplication window",
      );
      return "deduplicated";
    }

    const deliveryId = randomUUID();
    this.state.beginAlertDelivery({ deliveryId, ...normalizedAlert });
    const form = new URLSearchParams({
      token: this.credentials.applicationToken,
      user: this.credentials.userKey,
      title: normalizedAlert.title,
      message: normalizedAlert.message,
      priority: String(normalizedAlert.priority),
    });
    if (normalizedAlert.priority === 2) {
      form.set("sound", "persistent");
      form.set("retry", String(this.config.emergencyRetrySeconds));
      form.set("expire", String(this.config.emergencyExpireSeconds));
    }

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetcher("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form,
        signal: abortController.signal,
      });
      const parsed = pushoverResponseSchema.safeParse(await response.json());
      if (!response.ok || !parsed.success || parsed.data.status !== 1) {
        throw new Error(`Pushover rejected alert with HTTP ${response.status}`);
      }
      this.state.finishAlertDelivery(deliveryId, {
        delivered: true,
        ...(parsed.data.request ? { requestId: parsed.data.request } : {}),
        ...(parsed.data.receipt ? { receipt: parsed.data.receipt } : {}),
      });
      this.logger.info(
        { deliveryId, requestId: parsed.data.request, priority: normalizedAlert.priority },
        "Pushover alert delivered",
      );
      return "delivered";
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown Pushover delivery error";
      this.state.finishAlertDelivery(deliveryId, { delivered: false, error: message });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
