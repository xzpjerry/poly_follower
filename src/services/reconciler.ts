import { randomUUID } from "node:crypto";

import { Decimal } from "decimal.js";
import type { Logger } from "pino";

import type { AppConfig } from "../config.js";
import { resolveEventDate } from "../domain/event-selector.js";
import { buildReconciliationPlan } from "../domain/target-position.js";
import { compareLedgerToPublicPositions, reconstructEventLedger } from "../domain/trade-ledger.js";
import type { DiscoveredEvent, OrderBook, ReconciliationPlan, UserPosition } from "../domain/types.js";
import { StateDatabase } from "../persistence/database.js";
import { NoopAlertNotifier, type AlertNotifier } from "./alerts.js";
import { notifyDecisionChanges } from "./decision-audit.js";
import type {
  AuthenticatedClobPort,
  ClobPublicPort,
  DataPort,
  GammaPort,
  UserStreamHealthPort,
} from "./ports.js";
import { LiveSafetyController } from "./safety.js";

function filterAllowedPositions(
  positions: UserPosition[],
  event: DiscoveredEvent,
  role: string,
  logger: Logger,
): UserPosition[] {
  const allowed = new Set(event.assets.map((asset) => asset.tokenId));
  const included: UserPosition[] = [];
  for (const position of positions) {
    if (allowed.has(position.tokenId)) {
      included.push(position);
    } else {
      logger.warn({ role, tokenId: position.tokenId, eventId: event.eventId }, "Ignored position outside token filter");
    }
  }
  return included;
}

function eventAllowsBuys(event: DiscoveredEvent, nowMs: number, stopBeforeEndSeconds: number): boolean {
  if (!event.active || event.closed) {
    return false;
  }
  const endMs = Date.parse(event.endDate);
  if (!Number.isFinite(endMs)) {
    return false;
  }
  return nowMs < endMs - stopBeforeEndSeconds * 1000;
}

export class Reconciler {
  public constructor(
    private readonly config: AppConfig,
    private readonly gamma: GammaPort,
    private readonly data: DataPort,
    private readonly clob: ClobPublicPort,
    private readonly state: StateDatabase,
    private readonly logger: Logger,
    private readonly authenticatedClob: AuthenticatedClobPort | null = null,
    private readonly safety: LiveSafetyController | null = null,
    private readonly alerts: AlertNotifier = new NoopAlertNotifier(),
    private readonly userStreamHealth: UserStreamHealthPort | null = null,
  ) {}

  public async discover(): Promise<DiscoveredEvent> {
    const outcomeFilter = {
      includeYes: this.config.scope.includeYesTokens,
      includeNo: this.config.scope.includeNoTokens,
    };
    let event: DiscoveredEvent;
    if (this.config.scope.eventSlug) {
      event = await this.gamma.getEventBySlug(this.config.scope.eventSlug, outcomeFilter);
    } else {
      const { seriesSlug, eventDate, timeZone } = this.config.scope;
      if (!seriesSlug || !eventDate) {
        throw new Error("Validated Series discovery configuration is incomplete");
      }
      event = await this.gamma.getEventBySeriesDate(
        seriesSlug,
        resolveEventDate(eventDate, timeZone),
        outcomeFilter,
      );
    }
    this.state.upsertEvent(event);
    return event;
  }

  public async runOnce(eventOverride?: DiscoveredEvent): Promise<ReconciliationPlan> {
    const nowMs = Date.now();
    const event = eventOverride ?? (await this.discover());
    const leaderPositionsRaw = await this.data.getPositions(this.config.leaderProfileWallet, event.eventId);
    const followerPositionsRaw = this.config.followerProfileWallet
      ? await this.data.getPositions(this.config.followerProfileWallet, event.eventId)
      : [];
    const leaderPositions = filterAllowedPositions(leaderPositionsRaw, event, "leader", this.logger);
    const followerPositions = filterAllowedPositions(followerPositionsRaw, event, "follower", this.logger);
    let pendingOrders = this.state.getOpenOrders(event.eventId);
    let realizedLoss = this.state.getRealizedLoss(
      event.eventId,
      this.config.followerProfileWallet ?? "simulated-empty-follower",
    );
    let authenticatedLedgerHealthy = this.authenticatedClob === null;
    if (this.authenticatedClob) {
      const [authenticatedOpenOrders, authenticatedTrades] = await Promise.all([
        this.authenticatedClob.getOpenOrders(event),
        this.authenticatedClob.getTrades(event),
      ]);
      this.state.replaceOpenOrders(event.eventId, authenticatedOpenOrders);
      pendingOrders = authenticatedOpenOrders;
      for (const trade of authenticatedTrades) {
        const linkedAttempts = this.state.recordTradeLifecycle({
          eventId: event.eventId,
          tradeId: trade.tradeId,
          status: trade.status,
          orderIds: trade.orderIds,
          transactionHash: trade.transactionHash,
          source: "authenticated-poll",
          raw: trade.raw,
        });
        if (linkedAttempts > 0 && trade.status === "CONFIRMED") {
          await this.alerts.send({
            dedupeKey: `trade-confirmed:${trade.tradeId}`,
            title: "Polymarket order confirmed",
            message: `Trade ${trade.tradeId} reached CONFIRMED for ${event.eventSlug}`,
            priority: 0,
          });
        }
        if (linkedAttempts > 0 && trade.status === "FAILED" && this.config.execution.mode === "live") {
          await this.requireSafety().arm("authenticated trade reached FAILED", {
            eventId: event.eventId,
            tradeId: trade.tradeId,
          });
        }
      }
      try {
        const ledger = reconstructEventLedger(authenticatedTrades, event.assets);
        const mismatches = compareLedgerToPublicPositions(
          ledger,
          followerPositions,
          event.assets.map((asset) => asset.tokenId),
        );
        authenticatedLedgerHealthy = mismatches.length === 0;
        if (authenticatedLedgerHealthy) {
          realizedLoss = ledger.realizedLoss;
          this.state.setRealizedLoss(event.eventId, this.authenticatedClob.funderAddress, realizedLoss);
        } else {
          this.logger.error(
            { eventId: event.eventId, mismatchCount: mismatches.length, mismatches },
            "Authenticated trade ledger disagrees with public follower positions; live execution is blocked",
          );
          if (this.config.execution.mode === "live") {
            await this.requireSafety().arm("authenticated ledger mismatch", {
              eventId: event.eventId,
              mismatchCount: mismatches.length,
            });
          }
        }
        this.logger.info(
          {
            eventId: event.eventId,
            authenticatedOpenOrders: authenticatedOpenOrders.length,
            authenticatedTrades: ledger.tradeCount,
            ledgerMatchesPublicPositions: authenticatedLedgerHealthy,
            realizedLoss: ledger.realizedLoss,
          },
          "Authenticated account state reconciled",
        );
      } catch (error) {
        authenticatedLedgerHealthy = false;
        this.logger.error(
          { eventId: event.eventId, error },
          "Authenticated trade ledger could not be reconstructed; live execution is blocked",
        );
        if (this.config.execution.mode === "live") {
          await this.requireSafety().arm("authenticated ledger reconstruction failed", {
            eventId: event.eventId,
          });
        }
      }
    }
    const unconfirmedLeaderZeroTokens = this.state.observeLeaderPositions(
      event.eventId,
      this.config.leaderProfileWallet,
      event.assets.map((asset) => asset.tokenId),
      leaderPositions,
    );

    this.state.recordPositions(event.eventId, this.config.leaderProfileWallet, "leader", leaderPositions);
    this.state.recordPositions(
      event.eventId,
      this.config.followerProfileWallet ?? "simulated-empty-follower",
      "follower",
      followerPositions,
    );

    const activeTokenIds = new Set([
      ...leaderPositions.filter((position) => new Decimal(position.size).greaterThan(0)).map((position) => position.tokenId),
      ...followerPositions.filter((position) => new Decimal(position.size).greaterThan(0)).map((position) => position.tokenId),
    ]);
    const books = new Map<string, OrderBook>();
    await Promise.all(
      [...activeTokenIds].map(async (tokenId) => {
        try {
          books.set(tokenId, await this.clob.getOrderBook(tokenId));
        } catch (error) {
          this.logger.error({ tokenId, error }, "Failed to fetch order book; token will fail closed");
        }
      }),
    );

    const plan = buildReconciliationPlan({
      event,
      leaderPositions,
      followerPositions,
      pendingOrders,
      books,
      copyRatio: this.config.copy.shareRatio,
      maxOpenDebit: this.config.risk.maxOpenDebitUsd,
      maxEventLoss: this.config.risk.maxEventLossUsd,
      realizedLoss,
      maxPriceDriftAbs: this.config.execution.maxPriceDriftAbs,
      maxSlippageBps: this.config.execution.maxSlippageBps,
      maxBookAgeMs: this.config.execution.maxBookAgeMs,
      nowMs,
      allowBuys: eventAllowsBuys(event, nowMs, this.config.execution.stopBeforeEndSeconds),
      unconfirmedLeaderZeroTokens,
    });
    this.state.recordPlan(plan);

    const actionable = plan.decisions.filter((decision) => decision.action === "BUY" || decision.action === "SELL");
    const skipped = plan.decisions.filter((decision) => decision.action === "SKIP");
    const decisionSummary = plan.decisions.reduce<Record<string, number>>((summary, decision) => {
      const key = `${decision.action}:${decision.reason}`;
      summary[key] = (summary[key] ?? 0) + 1;
      return summary;
    }, {});
    this.logger.info(
      {
        runId: plan.runId,
        eventId: plan.eventId,
        eventSlug: plan.eventSlug,
        capScale: plan.capScale,
        estimatedTargetRisk: plan.estimatedTargetRisk,
        actionable: actionable.length,
        skipped: skipped.length,
        decisionSummary,
        executionMode: this.config.execution.mode,
      },
      "Reconciliation completed",
    );
    for (const decision of [...actionable, ...skipped]) {
      this.logger.info(
        { runId: plan.runId, ...decision, executionMode: this.config.execution.mode },
        this.config.execution.mode === "live" ? "Live reconciliation decision" : "Non-live reconciliation decision",
      );
    }

    if (this.config.alerts.pushover.enabled && this.config.execution.mode !== "dry-run") {
      try {
        const notified = await notifyDecisionChanges(
          this.state,
          this.alerts,
          plan,
          this.config.execution.mode,
        );
        this.logger.info({ runId: plan.runId, notified }, "Decision audit notifications reconciled");
      } catch (error) {
        this.logger.error({ runId: plan.runId, error }, "Decision audit notification failed");
        if (this.config.execution.mode === "live") {
          await this.requireSafety().arm("decision audit notification failed", {
            eventId: event.eventId,
            runId: plan.runId,
          });
        }
        return plan;
      }
    }

    if (this.config.execution.mode === "live") {
      if (!this.authenticatedClob) {
        throw new Error("Live mode requires an authenticated CLOB client");
      }
      if (!authenticatedLedgerHealthy) {
        this.logger.error({ runId: plan.runId }, "Live order blocked by unhealthy authenticated ledger");
        return plan;
      }
      if (!this.userStreamHealth?.isHealthy()) {
        this.logger.error(
          { runId: plan.runId, eventId: event.eventId },
          "Live order blocked until the User WebSocket is healthy",
        );
        return plan;
      }
      await this.requireSafety().assertCanTrade();
      const staleAttempts = this.state.getAllStaleUnresolvedAttempts(
        this.config.execution.terminalTimeoutSeconds,
      );
      if (staleAttempts.length > 0) {
        await this.requireSafety().arm("execution terminal timeout", {
          eventId: event.eventId,
          attemptIds: staleAttempts,
        });
        return plan;
      }
      if (this.state.hasAnyUnresolvedExecutionAttempt()) {
        this.logger.error(
          { runId: plan.runId, eventId: event.eventId },
          "Live order blocked by an unresolved prior execution attempt",
        );
        return plan;
      }

      const decision = actionable.slice(0, this.config.execution.maxOrdersPerCycle)[0];
      if (decision) {
        const asset = event.assets.find((candidate) => candidate.tokenId === decision.tokenId);
        if (!asset) {
          throw new Error(`Actionable token ${decision.tokenId} is outside the discovered event`);
        }
        try {
          await this.authenticatedClob.preflightFok(decision);
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "unknown preflight error";
          this.logger.error(
            { runId: plan.runId, tokenId: decision.tokenId, error },
            "Live order preflight failed before any execution intent was created",
          );
          try {
            await this.alerts.send({
              dedupeKey: `preflight-failed:${plan.runId}:${decision.tokenId}`,
              title: "Polymarket order preflight failed",
              message: [
                `Event: ${event.eventSlug}`,
                `Run: ${plan.runId}`,
                `Action: ${decision.action}`,
                `Token: ${decision.tokenId}`,
                `Delta: ${decision.deltaSize}`,
                `Reason: ${errorMessage}`,
              ].join("\n"),
              priority: 1,
            });
          } catch (notificationError) {
            this.logger.error(
              { runId: plan.runId, notificationError },
              "Preflight failure notification could not be delivered",
            );
          }
          return plan;
        }
        const attemptId = randomUUID();
        this.state.beginExecutionAttempt({
          attemptId,
          runId: plan.runId,
          eventId: event.eventId,
          tokenId: decision.tokenId,
          side: decision.action as "BUY" | "SELL",
          requestedShares: new Decimal(decision.deltaSize).abs().toFixed(),
          expectedDebit: decision.estimatedDebit,
        });
        try {
          await this.alerts.send({
            dedupeKey: `order-submitting:${attemptId}`,
            title: "Polymarket order submitting",
            message: [
              `Event: ${event.eventSlug}`,
              `Run: ${plan.runId}`,
              `Attempt: ${attemptId}`,
              `Action: ${decision.action}`,
              `Token: ${decision.tokenId}`,
              `Shares: ${new Decimal(decision.deltaSize).abs().toFixed()}`,
              `Expected debit: ${decision.estimatedDebit}`,
              `Worst price: ${decision.worstPrice ?? "n/a"}`,
            ].join("\n"),
            priority: 1,
          });
        } catch (error) {
          this.state.abortExecutionAttempt(attemptId, {
            reason: "order intent notification failed before CLOB submission",
          });
          await this.requireSafety().arm("order intent notification failed", {
            eventId: event.eventId,
            runId: plan.runId,
            attemptId,
          });
          return plan;
        }
        try {
          const receipt = await this.authenticatedClob.executeFok(decision, asset);
          this.state.acceptExecutionAttempt(attemptId, receipt.orderId, { ...receipt }, receipt.tradeIds);
          await this.alerts.send({
            dedupeKey: `order-accepted:${receipt.orderId}`,
            title: "Polymarket order accepted",
            message: [
              `Event: ${event.eventSlug}`,
              `Run: ${plan.runId}`,
              `Attempt: ${attemptId}`,
              `Order: ${receipt.orderId}`,
              `Action: ${decision.action}`,
              `Token: ${decision.tokenId}`,
              `Shares: ${new Decimal(decision.deltaSize).abs().toFixed()}`,
              `CLOB status: ${receipt.status}`,
              `Trades: ${receipt.tradeIds.join(",") || "pending"}`,
              "Terminal status: pending",
            ].join("\n"),
            priority: 1,
          });
          this.logger.info(
            {
              runId: plan.runId,
              attemptId,
              orderId: receipt.orderId,
              status: receipt.status,
              tradeIds: receipt.tradeIds,
              transactionHashes: receipt.transactionHashes,
            },
            "Guarded FOK order accepted; terminal confirmation is still required",
          );
        } catch (error) {
          await this.requireSafety().arm("live order result unresolved", {
            eventId: event.eventId,
            attemptId,
            tokenId: decision.tokenId,
          });
          this.logger.fatal(
            { runId: plan.runId, attemptId, tokenId: decision.tokenId, error },
            "Live order result is unresolved; execution is now fail-closed",
          );
          throw error;
        }
      }
    }
    return plan;
  }

  private requireSafety(): LiveSafetyController {
    if (!this.safety) {
      throw new Error("Live mode requires a safety controller");
    }
    return this.safety;
  }
}
