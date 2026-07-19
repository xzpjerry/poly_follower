import type {
  DiscoveredEvent,
  FeeSchedule,
  OrderBook,
  TrackedAsset,
  UserPosition,
} from "../src/domain/types.js";

export const noFee: FeeSchedule = {
  enabled: false,
  rate: "0",
  exponent: 1,
  takerOnly: true,
};

export const weatherFee: FeeSchedule = {
  enabled: true,
  rate: "0.05",
  exponent: 1,
  takerOnly: true,
};

export function makeAsset(overrides: Partial<TrackedAsset> = {}): TrackedAsset {
  return {
    eventId: "event-123",
    eventSlug: "sample-weather-event",
    marketSlug: "sample-weather-event-32c",
    marketTitle: "Will the sample temperature be 32°C?",
    conditionId: "0xcondition",
    tokenId: "token-32-yes",
    outcome: "Yes",
    negRisk: true,
    tickSize: "0.01",
    minOrderSize: "5",
    acceptingOrders: true,
    endDate: "2099-07-19T12:00:00Z",
    feeSchedule: weatherFee,
    ...overrides,
  };
}

export function makeEvent(assets: TrackedAsset[]): DiscoveredEvent {
  return {
    eventId: "event-123",
    eventSlug: "sample-weather-event",
    title: "Sample weather event",
    active: true,
    closed: false,
    endDate: "2099-07-19T12:00:00Z",
    assets,
    raw: {},
  };
}

export function makePosition(tokenId: string, size: string, avgPrice = "0.29"): UserPosition {
  return {
    proxyWallet: "0x1111111111111111111111111111111111111111",
    tokenId,
    conditionId: "0xcondition",
    size,
    avgPrice,
    initialValue: "0",
    currentValue: "0",
    curPrice: avgPrice,
    outcome: "Yes",
    marketSlug: "market",
    eventSlug: "sample-weather-event",
    raw: {},
  };
}

export function makeBook(
  tokenId: string,
  asks: Array<{ price: string; size: string }>,
  bids: Array<{ price: string; size: string }> = [],
  timestampMs = Date.now(),
): OrderBook {
  return {
    tokenId,
    market: "0xcondition",
    timestampMs,
    asks,
    bids,
    raw: {},
  };
}
