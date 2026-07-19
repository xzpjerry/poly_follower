export interface FeeSchedule {
  enabled: boolean;
  rate: string;
  exponent: number;
  takerOnly: boolean;
}

export interface TrackedAsset {
  eventId: string;
  eventSlug: string;
  marketSlug: string;
  marketTitle: string;
  conditionId: string;
  tokenId: string;
  outcome: string;
  negRisk: boolean;
  tickSize: string;
  minOrderSize: string;
  acceptingOrders: boolean;
  endDate: string;
  feeSchedule: FeeSchedule;
}

export interface DiscoveredEvent {
  eventId: string;
  eventSlug: string;
  title: string;
  active: boolean;
  closed: boolean;
  endDate: string;
  assets: TrackedAsset[];
  raw: unknown;
}

export interface UserPosition {
  proxyWallet: string;
  tokenId: string;
  conditionId: string;
  size: string;
  avgPrice: string;
  initialValue: string;
  currentValue: string;
  curPrice: string;
  outcome: string;
  marketSlug: string;
  eventSlug: string;
  raw: unknown;
}

export interface UserActivity {
  proxyWallet: string;
  timestamp: number;
  conditionId: string;
  type: string;
  size: string;
  usdcSize: string;
  transactionHash: string;
  price: string;
  tokenId: string;
  side: "BUY" | "SELL";
  outcome: string;
  marketSlug: string;
  eventSlug: string;
  raw: unknown;
}

export interface OrderBookLevel {
  price: string;
  size: string;
}

export interface OrderBook {
  tokenId: string;
  market: string;
  timestampMs: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  minOrderSize?: string;
  tickSize?: string;
  negRisk?: boolean;
  raw: unknown;
}

export interface PendingOrder {
  orderId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  remainingShares: string;
  reservedDebit: string;
}

export type DecisionAction = "BUY" | "SELL" | "HOLD" | "SKIP";

export interface ReconciliationDecision {
  tokenId: string;
  marketSlug: string;
  outcome: string;
  action: DecisionAction;
  leaderSize: string;
  rawTargetSize: string;
  targetSize: string;
  confirmedSize: string;
  effectiveSize: string;
  deltaSize: string;
  estimatedDebit: string;
  estimatedProceeds: string;
  worstPrice: string | null;
  reason: string;
}

export interface ReconciliationPlan {
  runId: string;
  eventId: string;
  eventSlug: string;
  copyRatio: string;
  capScale: string;
  maxEventRisk: string;
  realizedLoss: string;
  availableRisk: string;
  estimatedTargetRisk: string;
  createdAt: string;
  decisions: ReconciliationDecision[];
}
