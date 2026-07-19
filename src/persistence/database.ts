import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import type {
  DiscoveredEvent,
  PendingOrder,
  ReconciliationPlan,
  UserActivity,
  UserPosition,
} from "../domain/types.js";

interface CursorRow {
  last_timestamp: number;
}

interface RiskRow {
  realized_loss: string;
}

export class StateDatabase {
  private readonly database: Database.Database;

  public constructor(databasePath: string) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
    this.database = new Database(databasePath);
    this.database.pragma("journal_mode = WAL");
    this.database.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        event_slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        end_date TEXT NOT NULL,
        active INTEGER NOT NULL,
        closed INTEGER NOT NULL,
        discovered_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tracked_assets (
        token_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL REFERENCES events(event_id),
        condition_id TEXT NOT NULL,
        market_slug TEXT NOT NULL,
        market_title TEXT NOT NULL,
        outcome TEXT NOT NULL,
        neg_risk INTEGER NOT NULL,
        tick_size TEXT NOT NULL,
        min_order_size TEXT NOT NULL,
        accepting_orders INTEGER NOT NULL,
        end_date TEXT NOT NULL,
        fee_schedule_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS tracked_assets_event_idx ON tracked_assets(event_id);

      CREATE TABLE IF NOT EXISTS leader_activity (
        fingerprint TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        leader_wallet TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        transaction_hash TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        size TEXT NOT NULL,
        price TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        observed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS leader_activity_lookup_idx
      ON leader_activity(event_id, leader_wallet, timestamp);

      CREATE TABLE IF NOT EXISTS position_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL,
        wallet TEXT NOT NULL,
        role TEXT NOT NULL,
        token_id TEXT NOT NULL,
        size TEXT NOT NULL,
        avg_price TEXT NOT NULL,
        initial_value TEXT NOT NULL,
        current_value TEXT NOT NULL,
        snapshot_at TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS position_snapshots_lookup_idx
      ON position_snapshots(event_id, wallet, snapshot_at);

      CREATE TABLE IF NOT EXISTS reconciliation_runs (
        run_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        event_slug TEXT NOT NULL,
        copy_ratio TEXT NOT NULL,
        cap_scale TEXT NOT NULL,
        max_event_risk TEXT NOT NULL,
        realized_loss TEXT NOT NULL,
        available_risk TEXT NOT NULL,
        estimated_target_risk TEXT NOT NULL,
        created_at TEXT NOT NULL,
        plan_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS planned_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES reconciliation_runs(run_id),
        event_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_size TEXT NOT NULL,
        effective_size TEXT NOT NULL,
        delta_size TEXT NOT NULL,
        estimated_debit TEXT NOT NULL,
        estimated_proceeds TEXT NOT NULL,
        worst_price TEXT,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS risk_ledger (
        event_id TEXT NOT NULL,
        follower_wallet TEXT NOT NULL,
        open_cost_basis TEXT NOT NULL DEFAULT '0',
        reserved_buy_debit TEXT NOT NULL DEFAULT '0',
        fees_paid TEXT NOT NULL DEFAULT '0',
        realized_pnl TEXT NOT NULL DEFAULT '0',
        realized_loss TEXT NOT NULL DEFAULT '0',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(event_id, follower_wallet)
      );

      CREATE TABLE IF NOT EXISTS poll_cursors (
        source TEXT NOT NULL,
        leader_wallet TEXT NOT NULL,
        event_id TEXT NOT NULL,
        last_timestamp INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(source, leader_wallet, event_id)
      );

      CREATE TABLE IF NOT EXISTS open_orders (
        order_id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        side TEXT NOT NULL,
        remaining_shares TEXT NOT NULL,
        reserved_debit TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS leader_position_observations (
        event_id TEXT NOT NULL,
        leader_wallet TEXT NOT NULL,
        token_id TEXT NOT NULL,
        last_size TEXT NOT NULL,
        consecutive_zero INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(event_id, leader_wallet, token_id)
      );
    `);
  }

  public upsertEvent(event: DiscoveredEvent): void {
    const now = new Date().toISOString();
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO events (
             event_id, event_slug, title, end_date, active, closed, discovered_at, raw_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             event_slug = excluded.event_slug,
             title = excluded.title,
             end_date = excluded.end_date,
             active = excluded.active,
             closed = excluded.closed,
             discovered_at = excluded.discovered_at,
             raw_json = excluded.raw_json`,
        )
        .run(
          event.eventId,
          event.eventSlug,
          event.title,
          event.endDate,
          event.active ? 1 : 0,
          event.closed ? 1 : 0,
          now,
          JSON.stringify(event.raw),
        );

      const upsertAsset = this.database.prepare(
        `INSERT INTO tracked_assets (
           token_id, event_id, condition_id, market_slug, market_title, outcome,
           neg_risk, tick_size, min_order_size, accepting_orders, end_date,
           fee_schedule_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(token_id) DO UPDATE SET
           event_id = excluded.event_id,
           condition_id = excluded.condition_id,
           market_slug = excluded.market_slug,
           market_title = excluded.market_title,
           outcome = excluded.outcome,
           neg_risk = excluded.neg_risk,
           tick_size = excluded.tick_size,
           min_order_size = excluded.min_order_size,
           accepting_orders = excluded.accepting_orders,
           end_date = excluded.end_date,
           fee_schedule_json = excluded.fee_schedule_json,
           updated_at = excluded.updated_at`,
      );

      for (const asset of event.assets) {
        upsertAsset.run(
          asset.tokenId,
          asset.eventId,
          asset.conditionId,
          asset.marketSlug,
          asset.marketTitle,
          asset.outcome,
          asset.negRisk ? 1 : 0,
          asset.tickSize,
          asset.minOrderSize,
          asset.acceptingOrders ? 1 : 0,
          asset.endDate,
          JSON.stringify(asset.feeSchedule),
          now,
        );
      }
    });
    transaction();
  }

  public recordPositions(
    eventId: string,
    wallet: string,
    role: "leader" | "follower",
    positions: UserPosition[],
    snapshotAt = new Date().toISOString(),
  ): void {
    const insert = this.database.prepare(
      `INSERT INTO position_snapshots (
         event_id, wallet, role, token_id, size, avg_price, initial_value,
         current_value, snapshot_at, raw_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const transaction = this.database.transaction(() => {
      for (const position of positions) {
        insert.run(
          eventId,
          wallet,
          role,
          position.tokenId,
          position.size,
          position.avgPrice,
          position.initialValue,
          position.currentValue,
          snapshotAt,
          JSON.stringify(position.raw),
        );
      }
    });
    transaction();
  }

  public recordPlan(plan: ReconciliationPlan): void {
    const transaction = this.database.transaction(() => {
      this.database
        .prepare(
          `INSERT INTO reconciliation_runs (
             run_id, event_id, event_slug, copy_ratio, cap_scale, max_event_risk,
             realized_loss, available_risk, estimated_target_risk, created_at, plan_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          plan.runId,
          plan.eventId,
          plan.eventSlug,
          plan.copyRatio,
          plan.capScale,
          plan.maxEventRisk,
          plan.realizedLoss,
          plan.availableRisk,
          plan.estimatedTargetRisk,
          plan.createdAt,
          JSON.stringify(plan),
        );

      const insertDecision = this.database.prepare(
        `INSERT INTO planned_decisions (
           run_id, event_id, token_id, action, target_size, effective_size,
           delta_size, estimated_debit, estimated_proceeds, worst_price, reason, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const decision of plan.decisions) {
        insertDecision.run(
          plan.runId,
          plan.eventId,
          decision.tokenId,
          decision.action,
          decision.targetSize,
          decision.effectiveSize,
          decision.deltaSize,
          decision.estimatedDebit,
          decision.estimatedProceeds,
          decision.worstPrice,
          decision.reason,
          plan.createdAt,
        );
      }
    });
    transaction();
  }

  public observeLeaderPositions(
    eventId: string,
    leaderWallet: string,
    trackedTokenIds: string[],
    positions: UserPosition[],
    requiredZeroSnapshots = 2,
  ): Set<string> {
    const sizeByToken = new Map(positions.map((position) => [position.tokenId, position.size]));
    const select = this.database.prepare(
      `SELECT consecutive_zero FROM leader_position_observations
       WHERE event_id = ? AND leader_wallet = ? AND token_id = ?`,
    );
    const upsert = this.database.prepare(
      `INSERT INTO leader_position_observations (
         event_id, leader_wallet, token_id, last_size, consecutive_zero, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, leader_wallet, token_id) DO UPDATE SET
         last_size = excluded.last_size,
         consecutive_zero = excluded.consecutive_zero,
         updated_at = excluded.updated_at`,
    );
    const unconfirmed = new Set<string>();
    const transaction = this.database.transaction(() => {
      for (const tokenId of trackedTokenIds) {
        const size = sizeByToken.get(tokenId) ?? "0";
        const isZero = Number(size) <= 0;
        const previous = select.get(eventId, leaderWallet, tokenId) as { consecutive_zero: number } | undefined;
        const consecutiveZero = isZero ? (previous?.consecutive_zero ?? 0) + 1 : 0;
        upsert.run(eventId, leaderWallet, tokenId, size, consecutiveZero, new Date().toISOString());
        if (isZero && consecutiveZero < requiredZeroSnapshots) {
          unconfirmed.add(tokenId);
        }
      }
    });
    transaction();
    return unconfirmed;
  }

  public insertActivity(eventId: string, leaderWallet: string, activity: UserActivity[]): number {
    const insert = this.database.prepare(
      `INSERT OR IGNORE INTO leader_activity (
         fingerprint, event_id, leader_wallet, timestamp, transaction_hash,
         token_id, side, size, price, raw_json, observed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    let inserted = 0;
    const occurrence = new Map<string, number>();
    const transaction = this.database.transaction(() => {
      for (const item of activity) {
        const base = [
          item.transactionHash,
          item.tokenId,
          item.side,
          item.size,
          item.price,
          String(item.timestamp),
        ].join("|");
        const ordinal = occurrence.get(base) ?? 0;
        occurrence.set(base, ordinal + 1);
        const fingerprint = createHash("sha256").update(`${base}|${ordinal}`).digest("hex");
        const result = insert.run(
          fingerprint,
          eventId,
          leaderWallet,
          item.timestamp,
          item.transactionHash,
          item.tokenId,
          item.side,
          item.size,
          item.price,
          JSON.stringify(item.raw),
          new Date().toISOString(),
        );
        inserted += result.changes;
      }
    });
    transaction();
    return inserted;
  }

  public getCursor(source: string, leaderWallet: string, eventId: string): number | null {
    const row = this.database
      .prepare(
        `SELECT last_timestamp FROM poll_cursors
         WHERE source = ? AND leader_wallet = ? AND event_id = ?`,
      )
      .get(source, leaderWallet, eventId) as CursorRow | undefined;
    return row?.last_timestamp ?? null;
  }

  public setCursor(source: string, leaderWallet: string, eventId: string, timestamp: number): void {
    this.database
      .prepare(
        `INSERT INTO poll_cursors (source, leader_wallet, event_id, last_timestamp, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(source, leader_wallet, event_id) DO UPDATE SET
           last_timestamp = excluded.last_timestamp,
           updated_at = excluded.updated_at`,
      )
      .run(source, leaderWallet, eventId, timestamp, new Date().toISOString());
  }

  public getRealizedLoss(eventId: string, followerWallet: string): string {
    const row = this.database
      .prepare(
        `SELECT realized_loss FROM risk_ledger
         WHERE event_id = ? AND follower_wallet = ?`,
      )
      .get(eventId, followerWallet) as RiskRow | undefined;
    return row?.realized_loss ?? "0";
  }

  public getOpenOrders(eventId: string): PendingOrder[] {
    const rows = this.database
      .prepare(
        `SELECT order_id, token_id, side, remaining_shares, reserved_debit
         FROM open_orders
         WHERE event_id = ? AND status IN ('live', 'matched', 'delayed')`,
      )
      .all(eventId) as Array<{
      order_id: string;
      token_id: string;
      side: "BUY" | "SELL";
      remaining_shares: string;
      reserved_debit: string;
    }>;

    return rows.map((row) => ({
      orderId: row.order_id,
      tokenId: row.token_id,
      side: row.side,
      remainingShares: row.remaining_shares,
      reservedDebit: row.reserved_debit,
    }));
  }

  public close(): void {
    this.database.close();
  }
}
