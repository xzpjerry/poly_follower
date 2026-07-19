import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { StateDatabase } from "../src/persistence/database.js";
import { NoopAlertNotifier } from "../src/services/alerts.js";
import { LiveSafetyController } from "../src/services/safety.js";
import { UserStream } from "../src/services/user-stream.js";
import { makeAsset, makeConfig, makeEvent } from "./fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeSocket extends EventEmitter {
  public readyState: number = WebSocket.CONNECTING;
  public readonly sent: string[] = [];

  public open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open");
  }

  public send(value: string): void {
    this.sent.push(value);
  }

  public close(): void {
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }
}

describe("UserStream", () => {
  it("subscribes every Event condition and keeps an attempt blocked until CONFIRMED", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "weather-follower-user-stream-"));
    temporaryDirectories.push(directory);
    const state = new StateDatabase(path.join(directory, "state.sqlite"));
    state.beginExecutionAttempt({
      attemptId: "attempt-1",
      runId: "run-1",
      eventId: "event-123",
      tokenId: "token-a",
      side: "BUY",
      requestedShares: "10",
      expectedDebit: "2.5",
    });
    state.acceptExecutionAttempt("attempt-1", "order-1", { status: "matched" }, ["trade-1"]);
    const first = makeAsset({ tokenId: "token-a", conditionId: "0xcondition-a" });
    const second = makeAsset({ tokenId: "token-b", conditionId: "0xcondition-b" });
    const event = makeEvent([first, second]);
    const config = makeConfig({
      execution: { mode: "live" },
      safety: { killSwitchPath: path.join(directory, "LIVE_TRADING_DISABLED") },
    });
    const alerts = new NoopAlertNotifier();
    const safety = new LiveSafetyController(state, config.safety.killSwitchPath, alerts, pino({ enabled: false }));
    const socket = new FakeSocket();
    const stream = new UserStream(
      { key: "api-key", secret: "api-secret", passphrase: "passphrase" },
      config,
      state,
      safety,
      alerts,
      pino({ enabled: false }),
      () => socket as unknown as WebSocket,
    );
    stream.setEvent(event);
    const abortController = new AbortController();
    const running = stream.run(abortController.signal);
    socket.open();

    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const subscription = JSON.parse(socket.sent[0] ?? "{}") as { markets: string[] };
    expect(subscription.markets).toEqual(["0xcondition-a", "0xcondition-b"]);
    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          event_type: "trade",
          id: "trade-1",
          market: "0xcondition-a",
          asset_id: "token-a",
          status: "MATCHED",
          taker_order_id: "order-1",
          maker_orders: [],
          transaction_hash: null,
        }),
      ),
    );
    await vi.waitFor(() => expect(state.getExecutionAttemptState("attempt-1")).toBe("matched"));
    expect(state.hasUnresolvedExecutionAttempt("event-123")).toBe(true);

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          event_type: "trade",
          id: "trade-1",
          market: "0xcondition-a",
          asset_id: "token-a",
          status: "CONFIRMED",
          taker_order_id: "order-1",
          maker_orders: [],
          transaction_hash: "0xtransaction",
        }),
      ),
    );
    await vi.waitFor(() => expect(state.getExecutionAttemptState("attempt-1")).toBe("confirmed"));
    expect(state.hasUnresolvedExecutionAttempt("event-123")).toBe(false);

    abortController.abort();
    await running;
    state.close();
  });
});
