// ════════════════════════════════════════════════════════════════
//  Phase 3 Persistence — Trade Plan, Sizing, Portfolio Fit,
//  Execution Readiness, Lifecycle
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type {
  Phase3TradePlan, PositionSizingResult, PortfolioFitResult,
  ExecutionReadiness, SignalLifecycle, Phase3RiskBreakdown,
} from '../types/phase3.types';

/**
 * Persist all Phase 3 artifacts for a given signal.
 * Call this AFTER saveSignals() has returned the real signal ID.
 *
 * `riskBreakdown` is optional so existing callers (Phase 4, which does
 * not carry the full breakdown through its envelope) keep working.
 * When present, a q365_signal_risk_snapshots row is written.
 */
export async function savePhase3Artifacts(
  signalId: number,
  tradePlan: Phase3TradePlan,
  sizing: PositionSizingResult,
  fit: PortfolioFitResult,
  readiness: ExecutionReadiness,
  lifecycle: SignalLifecycle,
  riskBreakdown?: Phase3RiskBreakdown,
): Promise<void> {
  await Promise.all([
    saveTradePlan(signalId, tradePlan),
    savePositionSizing(signalId, sizing),
    savePortfolioFit(signalId, fit),
    saveExecutionReadiness(signalId, readiness),
    saveLifecycle(signalId, lifecycle),
    riskBreakdown ? saveRiskSnapshot(signalId, riskBreakdown) : Promise.resolve(),
  ]);
}

async function saveRiskSnapshot(signalId: number, r: Phase3RiskBreakdown): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_risk_snapshots
      (signal_id, standalone_risk_score, portfolio_risk_score,
       total_risk_score, risk_band, risk_factors_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      signalId, r.standaloneRiskScore, r.portfolioRiskScore,
      r.totalRiskScore, r.riskBand, JSON.stringify(r.riskFactors),
    ],
  );
}

async function saveTradePlan(signalId: number, tp: Phase3TradePlan): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_trade_plans
      (signal_id, entry_type, entry_zone_low, entry_zone_high, stop_loss,
       initial_risk_per_unit, target1, target2, target3,
       rr_target1, rr_target2, rr_target3)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signalId, tp.entryType, tp.entryZoneLow, tp.entryZoneHigh,
      tp.stopLoss, tp.initialRiskPerUnit,
      tp.target1, tp.target2, tp.target3,
      tp.rrTarget1, tp.rrTarget2, tp.rrTarget3,
    ],
  );
}

async function savePositionSizing(signalId: number, s: PositionSizingResult): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_position_sizing
      (signal_id, capital_model, portfolio_capital, risk_budget_pct,
       risk_budget_amount, initial_risk_per_unit, position_size_units,
       gross_position_value, validation_status, warnings_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signalId, s.capitalModel, s.portfolioCapital, s.riskBudgetPct,
      s.riskBudgetAmount, s.initialRiskPerUnit, s.positionSizeUnits,
      s.grossPositionValue, s.validationStatus,
      JSON.stringify(s.warnings),
    ],
  );
}

async function savePortfolioFit(signalId: number, f: PortfolioFitResult): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_portfolio_fit
      (signal_id, fit_score, sector_exposure_impact, direction_impact,
       capital_availability, correlation_cluster, correlation_penalty,
       portfolio_decision, penalties_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      signalId, f.fitScore, f.sectorExposureImpact, f.directionImpact,
      f.capitalAvailability, f.correlationCluster, f.correlationPenalty,
      f.portfolioDecision, JSON.stringify(f.penalties),
    ],
  );

  // Back-fill the main q365_signals.portfolio_fit_score column so the
  // reader (getActiveSignals) surfaces the real Phase 3 score instead
  // of the placeholder 0 saveSignals wrote at insert time.
  await db.query(
    `UPDATE q365_signals SET portfolio_fit_score = ? WHERE id = ?`,
    [f.fitScore, signalId],
  );
}

async function saveExecutionReadiness(signalId: number, r: ExecutionReadiness): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_execution_readiness
      (signal_id, status, action_tag, priority_rank, approval_decision, reasons_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      signalId, r.status, r.actionTag, r.priorityRank,
      r.approvalDecision, JSON.stringify(r.reasons),
    ],
  );
}

async function saveLifecycle(signalId: number, lc: SignalLifecycle): Promise<void> {
  await db.query(
    `INSERT INTO q365_signal_lifecycle
      (signal_id, state, reason, changed_at)
     VALUES (?, ?, ?, ?)`,
    [signalId, lc.state, lc.reason, lc.changedAt],
  );
}

// ── Public lifecycle transition helper ─────────────────────
//
// Called by the lifecycle POST endpoint and by any engine code
// that needs to advance a signal's state after creation. Always
// appends a row, never updates. The whitelist of allowed states
// reflects the Phase 3 §8 lifecycle: generated → approved →
// ready → entered → exited, with invalidated / expired / rejected
// as terminal side-branches.
//
// `generated` is included so operational tooling can re-assert
// the initial state if needed (e.g. during a backfill), but
// saveSignals already writes it automatically at persist time.

export const ALLOWED_LIFECYCLE_STATES = [
  'generated',
  'approved',
  'ready',
  'entered',
  'exited',
  'invalidated',
  'expired',
  'rejected',
  'archived',
] as const;
export type LifecycleState = typeof ALLOWED_LIFECYCLE_STATES[number];

export async function transitionSignalLifecycle(
  signalId: number,
  state: LifecycleState,
  reason: string,
  changedAt: string = new Date().toISOString(),
): Promise<void> {
  if (!ALLOWED_LIFECYCLE_STATES.includes(state)) {
    throw new Error(`Invalid lifecycle state: ${state}`);
  }
  await db.query(
    `INSERT INTO q365_signal_lifecycle
      (signal_id, state, reason, changed_at)
     VALUES (?, ?, ?, ?)`,
    [signalId, state, reason, changedAt],
  );
}

/**
 * Load Phase 3 artifacts for a signal.
 */
export async function loadPhase3Artifacts(signalId: number): Promise<{
  tradePlan: any;
  sizing: any;
  fit: any;
  readiness: any;
  lifecycle: any[];
} | null> {
  const [tp, sz, ft, er, lc] = await Promise.all([
    db.query(`SELECT * FROM q365_signal_trade_plans WHERE signal_id = ? LIMIT 1`, [signalId]),
    db.query(`SELECT * FROM q365_signal_position_sizing WHERE signal_id = ? LIMIT 1`, [signalId]),
    db.query(`SELECT * FROM q365_signal_portfolio_fit WHERE signal_id = ? LIMIT 1`, [signalId]),
    db.query(`SELECT * FROM q365_signal_execution_readiness WHERE signal_id = ? LIMIT 1`, [signalId]),
    db.query(`SELECT * FROM q365_signal_lifecycle WHERE signal_id = ? ORDER BY changed_at`, [signalId]),
  ]);

  return {
    tradePlan: tp.rows[0] ?? null,
    sizing: sz.rows[0] ?? null,
    fit: ft.rows[0] ?? null,
    readiness: er.rows[0] ?? null,
    lifecycle: lc.rows,
  };
}
