import "dotenv/config";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { Decimal } from "decimal.js";
import YAML from "yaml";
import { z } from "zod";

const addressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);
const signatureTypeSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
]);

const configSchema = z
  .object({
    leader_profile_wallet: addressSchema,
    follower_profile_wallet: addressSchema.nullable().optional(),
    simulate_empty_follower: z.boolean().default(false),
    scope: z.object({
      event_slug: z.string().min(1),
      include_yes_tokens: z.boolean().default(true),
      include_no_tokens: z.boolean().default(true),
    }),
    copy: z.object({
      share_ratio: z.string(),
      sync_existing_positions_on_start: z.literal(true).default(true),
    }),
    risk: z.object({
      max_open_debit_usd: z.string(),
      max_event_loss_usd: z.string(),
    }),
    monitoring: z.object({
      activity_poll_ms: z.number().int().min(250).default(1500),
      activity_overlap_seconds: z.number().int().min(0).default(10),
      full_reconcile_seconds: z.number().int().min(1).default(15),
      request_timeout_ms: z.number().int().min(1000).default(10_000),
    }),
    execution: z.object({
      mode: z.enum(["dry-run", "authenticated-readonly", "live"]),
      signature_type: signatureTypeSchema.default(3),
      max_orders_per_cycle: z.literal(1).default(1),
      max_signal_age_seconds: z.number().int().min(0).default(30),
      max_price_drift_abs: z.string().default("0.02"),
      max_slippage_bps: z.number().int().min(0).default(300),
      max_book_age_ms: z.number().int().min(100).default(2000),
      stop_before_end_seconds: z.number().int().min(0).default(120),
    }),
    state: z.object({
      database_path: z.string().min(1),
    }),
  })
  .superRefine((value, context) => {
    const followerFromEnv = process.env.FOLLOWER_PROFILE_WALLET?.trim();
    if (!value.simulate_empty_follower && !value.follower_profile_wallet && !followerFromEnv) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["follower_profile_wallet"],
        message: "A follower profile wallet is required unless simulate_empty_follower=true",
      });
    }

    for (const [field, raw] of [
      ["copy.share_ratio", value.copy.share_ratio],
      ["risk.max_open_debit_usd", value.risk.max_open_debit_usd],
      ["risk.max_event_loss_usd", value.risk.max_event_loss_usd],
      ["execution.max_price_drift_abs", value.execution.max_price_drift_abs],
    ] as const) {
      try {
        const decimal = new Decimal(raw);
        if (decimal.isNegative() || (field !== "execution.max_price_drift_abs" && decimal.isZero())) {
          throw new Error("must be positive");
        }
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: field.split("."),
          message: `${field} must be a valid positive decimal`,
        });
      }
    }

    if (!value.scope.include_yes_tokens && !value.scope.include_no_tokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scope"],
        message: "At least one outcome token type must be included",
      });
    }
  });

export interface AppConfig {
  leaderProfileWallet: string;
  followerProfileWallet: string | null;
  simulateEmptyFollower: boolean;
  scope: {
    eventSlug: string;
    includeYesTokens: boolean;
    includeNoTokens: boolean;
  };
  copy: {
    shareRatio: string;
    syncExistingPositionsOnStart: boolean;
  };
  risk: {
    maxOpenDebitUsd: string;
    maxEventLossUsd: string;
  };
  monitoring: {
    activityPollMs: number;
    activityOverlapSeconds: number;
    fullReconcileSeconds: number;
    requestTimeoutMs: number;
  };
  execution: {
    mode: "dry-run" | "authenticated-readonly" | "live";
    signatureType: 0 | 1 | 2 | 3;
    maxOrdersPerCycle: 1;
    maxSignalAgeSeconds: number;
    maxPriceDriftAbs: string;
    maxSlippageBps: number;
    maxBookAgeMs: number;
    stopBeforeEndSeconds: number;
  };
  state: {
    databasePath: string;
  };
}

export interface CliOptions {
  configPath: string;
  once: boolean;
}

export function parseCliOptions(argv: string[]): CliOptions {
  let configPath = process.env.APP_CONFIG ?? "config/example.yaml";
  let once = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--once") {
      once = true;
      continue;
    }
    if (argument === "--config") {
      const candidate = argv[index + 1];
      if (!candidate) {
        throw new Error("--config requires a path");
      }
      configPath = candidate;
      index += 1;
    }
  }

  return { configPath, once };
}

export async function loadConfig(configPath: string): Promise<AppConfig> {
  const absolutePath = path.resolve(configPath);
  const rawText = await readFile(absolutePath, "utf8");
  const rawConfig: unknown = YAML.parse(rawText);
  const parsed = configSchema.parse(rawConfig);
  const followerFromEnv = process.env.FOLLOWER_PROFILE_WALLET?.trim() || null;
  const followerProfileWallet = followerFromEnv ?? parsed.follower_profile_wallet ?? null;

  if (followerProfileWallet && !addressSchema.safeParse(followerProfileWallet).success) {
    throw new Error("FOLLOWER_PROFILE_WALLET is not a valid 0x-prefixed address");
  }

  if (parsed.execution.mode !== "dry-run" && !followerProfileWallet) {
    throw new Error("Authenticated modes require a follower profile wallet");
  }

  if (parsed.execution.mode === "live") {
    const confirmedEvent = process.env.POLYMARKET_LIVE_TRADING_EVENT?.trim();
    if (confirmedEvent !== parsed.scope.event_slug) {
      throw new Error(
        "Live execution requires POLYMARKET_LIVE_TRADING_EVENT to exactly match scope.event_slug",
      );
    }
  }

  return {
    leaderProfileWallet: parsed.leader_profile_wallet.toLowerCase(),
    followerProfileWallet: followerProfileWallet?.toLowerCase() ?? null,
    simulateEmptyFollower: parsed.simulate_empty_follower,
    scope: {
      eventSlug: parsed.scope.event_slug,
      includeYesTokens: parsed.scope.include_yes_tokens,
      includeNoTokens: parsed.scope.include_no_tokens,
    },
    copy: {
      shareRatio: parsed.copy.share_ratio,
      syncExistingPositionsOnStart: parsed.copy.sync_existing_positions_on_start,
    },
    risk: {
      maxOpenDebitUsd: parsed.risk.max_open_debit_usd,
      maxEventLossUsd: parsed.risk.max_event_loss_usd,
    },
    monitoring: {
      activityPollMs: parsed.monitoring.activity_poll_ms,
      activityOverlapSeconds: parsed.monitoring.activity_overlap_seconds,
      fullReconcileSeconds: parsed.monitoring.full_reconcile_seconds,
      requestTimeoutMs: parsed.monitoring.request_timeout_ms,
    },
    execution: {
      mode: parsed.execution.mode,
      signatureType: parsed.execution.signature_type,
      maxOrdersPerCycle: parsed.execution.max_orders_per_cycle,
      maxSignalAgeSeconds: parsed.execution.max_signal_age_seconds,
      maxPriceDriftAbs: parsed.execution.max_price_drift_abs,
      maxSlippageBps: parsed.execution.max_slippage_bps,
      maxBookAgeMs: parsed.execution.max_book_age_ms,
      stopBeforeEndSeconds: parsed.execution.stop_before_end_seconds,
    },
    state: {
      databasePath: path.resolve(path.dirname(absolutePath), "..", parsed.state.database_path),
    },
  };
}
