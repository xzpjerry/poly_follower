import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StateDatabase } from "../src/persistence/database.js";
import { PushoverNotifier } from "../src/services/alerts.js";
import { makeConfig } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("PushoverNotifier", () => {
  it("sends emergency fields, persists the receipt, and deduplicates repeats", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-alerts-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    const requests: URLSearchParams[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(init?.body as URLSearchParams);
      return new Response(
        JSON.stringify({ status: 1, request: "request-1", receipt: "receipt-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const config = makeConfig({
      alerts: {
        pushover: {
          enabled: true,
          requestTimeoutMs: 1000,
          emergencyRetrySeconds: 30,
          emergencyExpireSeconds: 3600,
          dedupeSeconds: 300,
        },
      },
    });
    const notifier = new PushoverNotifier(
      { applicationToken: "application-secret", userKey: "user-secret" },
      config.alerts.pushover,
      state,
      pino({ enabled: false }),
      fetcher,
    );
    const alert = {
      dedupeKey: "kill-switch:test",
      title: "Stopped",
      message: "Live trading disabled",
      priority: 2 as const,
    };

    await expect(notifier.send(alert)).resolves.toBe("delivered");
    await expect(notifier.send(alert)).resolves.toBe("deduplicated");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requests[0]?.get("priority")).toBe("2");
    expect(requests[0]?.get("sound")).toBe("persistent");
    expect(requests[0]?.get("retry")).toBe("30");
    expect(requests[0]?.get("expire")).toBe("3600");
    expect(requests[0]?.get("token")).toBe("application-secret");
    expect(state.getLatestAlertDelivery("kill-switch:test")).toEqual({
      state: "delivered",
      requestId: "request-1",
      receipt: "receipt-1",
    });
    state.close();
  });

  it("truncates titles and messages to Pushover character limits", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-alert-limits-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    let request: URLSearchParams | undefined;
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      request = init?.body as URLSearchParams;
      return new Response(JSON.stringify({ status: 1, request: "request-long" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const config = makeConfig({
      alerts: {
        pushover: {
          enabled: true,
          requestTimeoutMs: 1000,
          emergencyRetrySeconds: 30,
          emergencyExpireSeconds: 3600,
          dedupeSeconds: 300,
        },
      },
    });
    const notifier = new PushoverNotifier(
      { applicationToken: "application-secret", userKey: "user-secret" },
      config.alerts.pushover,
      state,
      pino({ enabled: false }),
      fetcher,
    );

    await notifier.send({
      dedupeKey: "long-message",
      title: "题".repeat(300),
      message: "审".repeat(1100),
      priority: 0,
    });
    expect([...(request?.get("title") ?? "")]).toHaveLength(250);
    expect([...(request?.get("message") ?? "")]).toHaveLength(1024);
    expect(request?.get("title")?.endsWith("…")).toBe(true);
    expect(request?.get("message")?.endsWith("…")).toBe(true);
    state.close();
  });
});
