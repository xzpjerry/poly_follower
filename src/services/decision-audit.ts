import { createHash } from "node:crypto";

import type { AppConfig } from "../config.js";
import type { ReconciliationDecision, ReconciliationPlan } from "../domain/types.js";
import { StateDatabase } from "../persistence/database.js";
import type { AlertNotifier } from "./alerts.js";

function fingerprint(decision: ReconciliationDecision): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        decision.action,
        decision.leaderSize,
        decision.targetSize,
        decision.confirmedSize,
        decision.effectiveSize,
        decision.deltaSize,
        decision.estimatedDebit,
        decision.estimatedProceeds,
        decision.worstPrice,
        decision.reason,
      ]),
    )
    .digest("hex");
}

function marketLabel(plan: ReconciliationPlan, decision: ReconciliationDecision): string {
  const prefix = `${plan.eventSlug}-`;
  return decision.marketSlug.startsWith(prefix)
    ? decision.marketSlug.slice(prefix.length)
    : decision.marketSlug;
}

function formatMessage(
  plan: ReconciliationPlan,
  decision: ReconciliationDecision,
  mode: AppConfig["execution"]["mode"],
): string {
  return [
    `Mode: ${mode}`,
    `Event: ${plan.eventSlug}`,
    `Run: ${plan.runId}`,
    `Market: ${marketLabel(plan, decision)} ${decision.outcome}`,
    `Action: ${decision.action}`,
    `Copy/cap scale: ${plan.copyRatio} / ${plan.capScale}`,
    `Leader/target: ${decision.leaderSize} / ${decision.targetSize}`,
    `Confirmed/effective: ${decision.confirmedSize} / ${decision.effectiveSize}`,
    `Delta: ${decision.deltaSize}`,
    `Worst price: ${decision.worstPrice ?? "n/a"}`,
    `Debit/proceeds: ${decision.estimatedDebit} / ${decision.estimatedProceeds}`,
    `Event risk: ${plan.estimatedTargetRisk} / ${plan.maxEventRisk}`,
    `Reason: ${decision.reason}`,
  ].join("\n");
}

export async function notifyDecisionChanges(
  state: StateDatabase,
  alerts: AlertNotifier,
  plan: ReconciliationPlan,
  mode: AppConfig["execution"]["mode"],
): Promise<number> {
  let notified = 0;
  for (const decision of plan.decisions) {
    const nextFingerprint = fingerprint(decision);
    const previous = state.getDecisionAlertState(plan.eventId, decision.tokenId);
    if (previous?.fingerprint === nextFingerprint) {
      continue;
    }

    const shouldNotify =
      decision.action !== "HOLD" || (previous !== null && previous.action !== "HOLD");
    if (shouldNotify) {
      await alerts.send({
        dedupeKey: `decision-change:${plan.runId}:${decision.tokenId}`,
        title: `[${mode}] ${decision.action} ${marketLabel(plan, decision)} ${decision.outcome}`,
        message: formatMessage(plan, decision, mode),
        priority: mode === "live" && (decision.action === "BUY" || decision.action === "SELL") ? 1 : 0,
      });
      notified += 1;
    }
    state.setDecisionAlertState(
      plan.eventId,
      decision.tokenId,
      nextFingerprint,
      decision.action,
    );
  }
  return notified;
}
