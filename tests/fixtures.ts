import type {
  DiscoveredEvent,
  FeeSchedule,
  OrderBook,
  TrackedAsset,
  UserPosition,
} from "../src/domain/types.js";
import type { AppConfig } from "../src/config.js";

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

type AppConfigOverrides = Partial<
  Omit<AppConfig, "scope" | "copy" | "risk" | "monitoring" | "execution" | "alerts" | "safety" | "state">
> & {
  scope?: Partial<AppConfig["scope"]>;
  copy?: Partial<AppConfig["copy"]>;
  risk?: Partial<AppConfig["risk"]>;
  monitoring?: Partial<AppConfig["monitoring"]>;
  execution?: Partial<AppConfig["execution"]>;
  alerts?: { pushover?: Partial<AppConfig["alerts"]["pushover"]> };
  safety?: Partial<AppConfig["safety"]>;
  state?: Partial<AppConfig["state"]>;
};

export function makeConfig(overrides: AppConfigOverrides = {}): AppConfig {
  const base: AppConfig = {
    leaderProfileWallet: "0x1111111111111111111111111111111111111111",
    followerProfileWallet: "0x2222222222222222222222222222222222222222",
    simulateEmptyFollower: false,
    scope: {
      eventSlug: "sample-weather-event",
      seriesSlug: null,
      eventDate: null,
      timeZone: "Asia/Hong_Kong",
      includeYesTokens: true,
      includeNoTokens: true,
    },
    copy: { shareRatio: "0.25", syncExistingPositionsOnStart: true },
    risk: { maxOpenDebitUsd: "5", maxEventLossUsd: "5" },
    monitoring: {
      activityPollMs: 250,
      activityOverlapSeconds: 10,
      fullReconcileSeconds: 15,
      requestTimeoutMs: 10_000,
    },
    execution: {
      mode: "dry-run",
      signatureType: 3,
      maxOrdersPerCycle: 1,
      maxSignalAgeSeconds: 30,
      maxPriceDriftAbs: "0.02",
      maxSlippageBps: 300,
      maxBookAgeMs: 2000,
      stopBeforeEndSeconds: 120,
      terminalTimeoutSeconds: 180,
    },
    alerts: {
      pushover: {
        enabled: false,
        requestTimeoutMs: 10_000,
        emergencyRetrySeconds: 30,
        emergencyExpireSeconds: 3600,
        dedupeSeconds: 300,
      },
    },
    safety: {
      killSwitchPath: "/tmp/polymarket-weather-follower-test-kill-switch",
      userStreamUnhealthySeconds: 60,
    },
    state: { databasePath: "/tmp/polymarket-weather-follower-test.sqlite" },
  };
  return {
    ...base,
    ...overrides,
    scope: { ...base.scope, ...overrides.scope },
    copy: { ...base.copy, ...overrides.copy },
    risk: { ...base.risk, ...overrides.risk },
    monitoring: { ...base.monitoring, ...overrides.monitoring },
    execution: { ...base.execution, ...overrides.execution },
    alerts: {
      pushover: { ...base.alerts.pushover, ...overrides.alerts?.pushover },
    },
    safety: { ...base.safety, ...overrides.safety },
    state: { ...base.state, ...overrides.state },
  };
}
