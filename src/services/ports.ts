import type {
  DiscoveredEvent,
  FollowerTrade,
  OrderBook,
  PendingOrder,
  ReconciliationDecision,
  TrackedAsset,
  UserActivity,
  UserPosition,
} from "../domain/types.js";
import type { ClobApiCredentials } from "../security/credentials.js";
import type { ExecutionReceipt } from "../polymarket/clob-authenticated-client.js";

export interface GammaPort {
  getEventBySlug(
    eventSlug: string,
    outcomeFilter: { includeYes: boolean; includeNo: boolean },
  ): Promise<DiscoveredEvent>;
  getEventBySeriesDate(
    seriesSlug: string,
    eventDate: string,
    outcomeFilter: { includeYes: boolean; includeNo: boolean },
  ): Promise<DiscoveredEvent>;
}

export interface DataPort {
  getPositions(user: string, eventId: string): Promise<UserPosition[]>;
  getActivity(user: string, eventId: string, startTimestamp: number): Promise<UserActivity[]>;
}

export interface ClobPublicPort {
  getOrderBook(tokenId: string): Promise<OrderBook>;
}

export interface AuthenticatedClobPort {
  readonly funderAddress: string;
  getOpenOrders(event: DiscoveredEvent): Promise<PendingOrder[]>;
  getTrades(event: DiscoveredEvent): Promise<FollowerTrade[]>;
  preflightFok(decision: ReconciliationDecision): Promise<void>;
  executeFok(decision: ReconciliationDecision, asset: TrackedAsset): Promise<ExecutionReceipt>;
  getUserWebSocketAuth(): ClobApiCredentials;
}

export interface UserStreamHealthPort {
  isHealthy(nowMs?: number): boolean;
}
