import WebSocket, { type RawData } from "ws";
import type { Logger } from "pino";
import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { DiscoveredEvent } from "../domain/types.js";
import { StateDatabase } from "../persistence/database.js";
import type { ClobApiCredentials } from "../security/credentials.js";
import type { AlertNotifier } from "./alerts.js";
import { LiveSafetyController } from "./safety.js";

const numberLike = z.union([z.number(), z.string()]);
const tradeEventSchema = z
  .object({
    event_type: z.literal("trade"),
    id: z.string().min(1),
    market: z.string().min(1),
    asset_id: z.string().min(1),
    status: z.enum(["MATCHED", "MINED", "CONFIRMED", "RETRYING", "FAILED"]),
    taker_order_id: z.string().optional(),
    maker_orders: z.array(z.object({ order_id: z.string() }).passthrough()).default([]),
    transaction_hash: z.string().nullish(),
  })
  .passthrough();
const orderEventSchema = z
  .object({
    event_type: z.literal("order"),
    id: z.string().min(1),
    market: z.string().min(1),
    asset_id: z.string().min(1),
    type: z.enum(["PLACEMENT", "UPDATE", "CANCELLATION"]),
    size_matched: numberLike.default("0"),
    original_size: numberLike.default("0"),
  })
  .passthrough();

export type UserWebSocketFactory = (url: string) => WebSocket;

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

export class UserStream {
  private readonly eventByCondition = new Map<string, string>();
  private markets: string[] = [];
  private activeSocket: WebSocket | null = null;
  private lastHealthyAtMs = 0;

  public constructor(
    private readonly credentials: ClobApiCredentials,
    private readonly config: AppConfig,
    private readonly state: StateDatabase,
    private readonly safety: LiveSafetyController,
    private readonly alerts: AlertNotifier,
    private readonly logger: Logger,
    private readonly socketFactory: UserWebSocketFactory = (url) => new WebSocket(url),
  ) {}

  public setEvent(event: DiscoveredEvent): void {
    const nextMarkets = [...new Set(event.assets.map((asset) => asset.conditionId.toLowerCase()))].sort();
    const changed = JSON.stringify(nextMarkets) !== JSON.stringify(this.markets);
    this.markets = nextMarkets;
    this.eventByCondition.clear();
    for (const market of nextMarkets) {
      this.eventByCondition.set(market, event.eventId);
    }
    if (changed && this.activeSocket?.readyState === WebSocket.OPEN) {
      this.activeSocket.close(1012, "event subscription changed");
    }
  }

  public isHealthy(nowMs = Date.now()): boolean {
    return (
      this.activeSocket?.readyState === WebSocket.OPEN &&
      nowMs - this.lastHealthyAtMs < this.config.safety.userStreamUnhealthySeconds * 1000
    );
  }

  public async run(signal: AbortSignal): Promise<void> {
    let reconnectDelayMs = 500;
    let outageStartedAtMs: number | null = Date.now();
    while (!signal.aborted) {
      if (this.markets.length === 0) {
        await sleep(250, signal);
        continue;
      }
      try {
        await this.runConnection(signal, () => {
          outageStartedAtMs = null;
          reconnectDelayMs = 500;
        });
      } catch (error) {
        if (!signal.aborted) {
          this.logger.error({ error }, "Polymarket user WebSocket disconnected");
        }
      }
      if (signal.aborted) {
        break;
      }
      outageStartedAtMs ??= Date.now();
      if (
        this.config.execution.mode === "live" &&
        Date.now() - outageStartedAtMs >= this.config.safety.userStreamUnhealthySeconds * 1000
      ) {
        await this.safety.arm("user WebSocket outage exceeded threshold", {
          unhealthySeconds: this.config.safety.userStreamUnhealthySeconds,
        });
        return;
      }
      await sleep(reconnectDelayMs, signal);
      reconnectDelayMs = Math.min(reconnectDelayMs * 2, 10_000);
    }
  }

  private async runConnection(signal: AbortSignal, onOpen: () => void): Promise<void> {
    const socket = this.socketFactory("wss://ws-subscriptions-clob.polymarket.com/ws/user");
    this.activeSocket = socket;
    await new Promise<void>((resolve, reject) => {
      let heartbeat: NodeJS.Timeout | null = null;
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        signal.removeEventListener("abort", abort);
        this.activeSocket = null;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const abort = (): void => {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close(1000, "shutdown");
        }
        finish();
      };

      signal.addEventListener("abort", abort, { once: true });
      socket.once("open", () => {
        this.lastHealthyAtMs = Date.now();
        onOpen();
        socket.send(
          JSON.stringify({
            auth: {
              apiKey: this.credentials.key,
              secret: this.credentials.secret,
              passphrase: this.credentials.passphrase,
            },
            markets: this.markets,
            type: "user",
          }),
        );
        heartbeat = setInterval(() => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send("PING");
          }
        }, 10_000);
        this.logger.info({ marketCount: this.markets.length }, "Polymarket user WebSocket connected");
      });
      socket.on("message", (raw: RawData) => {
        this.lastHealthyAtMs = Date.now();
        const text = raw.toString();
        if (text === "PONG") {
          return;
        }
        void this.handleMessage(text).catch(async (error: unknown) => {
          this.logger.error({ error }, "Failed to process Polymarket user WebSocket message");
          if (this.config.execution.mode === "live") {
            await this.safety.arm("user WebSocket message processing failed");
          }
        });
      });
      socket.once("close", () => finish());
      socket.once("error", (error) => finish(error));
    });
  }

  private async handleMessage(text: string): Promise<void> {
    const decoded: unknown = JSON.parse(text);
    const messages = Array.isArray(decoded) ? decoded : [decoded];
    for (const message of messages) {
      const envelope = z.object({ event_type: z.string(), market: z.string() }).passthrough().parse(message);
      const eventId = this.eventByCondition.get(envelope.market.toLowerCase());
      if (!eventId) {
        this.logger.warn({ market: envelope.market }, "Ignored user WebSocket event outside Event whitelist");
        continue;
      }
      if (envelope.event_type === "trade") {
        const trade = tradeEventSchema.parse(message);
        const orderIds = [
          ...(trade.taker_order_id ? [trade.taker_order_id] : []),
          ...trade.maker_orders.map((order) => order.order_id),
        ];
        const linkedAttempts = this.state.recordTradeLifecycle({
          eventId,
          tradeId: trade.id,
          status: trade.status,
          orderIds: [...new Set(orderIds)],
          transactionHash: trade.transaction_hash ?? null,
          source: "user-websocket",
          raw: message,
        });
        if (linkedAttempts > 0 && trade.status === "CONFIRMED") {
          await this.alerts.send({
            dedupeKey: `trade-confirmed:${trade.id}`,
            title: "Polymarket order confirmed",
            message: `Trade ${trade.id} reached CONFIRMED`,
            priority: 0,
          });
        }
        if (linkedAttempts > 0 && trade.status === "FAILED" && this.config.execution.mode === "live") {
          await this.safety.arm("user WebSocket trade reached FAILED", {
            eventId,
            tradeId: trade.id,
          });
        }
        continue;
      }
      if (envelope.event_type === "order") {
        const order = orderEventSchema.parse(message);
        const linkedAttempts = this.state.recordUserOrderUpdate({
          eventId,
          orderId: order.id,
          tokenId: order.asset_id,
          type: order.type,
          sizeMatched: String(order.size_matched),
          originalSize: String(order.original_size),
          source: "user-websocket",
          raw: message,
        });
        if (linkedAttempts > 0 && order.type === "CANCELLATION") {
          await this.alerts.send({
            dedupeKey: `order-cancelled:${order.id}`,
            title: "Polymarket order cancelled",
            message: `Order ${order.id} reached CANCELLATION; account will be reconciled before another order`,
            priority: 1,
          });
        }
      }
    }
  }
}
