// ════════════════════════════════════════════════════════════════
//  Phase 2 — Signal Engine Penalty Integration
//
//  Pure functions that translate a ManipulationHookResult into:
//   1. an in-place mutation of the QuantSignal (confidence/risk/
//      warnings/status), and
//   2. a ManipulationPenaltyRecord ready to persist once the signal
//      has a real DB id.
//
//  Policy mapping (per Phase 2 spec §5):
//    low      → no change
//    watch    → warning only, no penalty
//    elevated → -10 confidence, +5 risk, warning
//    high     → -20 confidence, +10 risk, strong warning
//    severe   → reject (status='invalidated'), max penalty
//
//  Bounded so a penalty alone can never invert a signal: confidence is
//  clamped to ≥0 and risk to ≤100.
// ════════════════════════════════════════════════════════════════

import type { QuantSignal } from '@/lib/signal-engine/types/signalEngine.types';
import type { ManipulationHookResult, ManipulationPenaltyRecord } from '../types';
import { loadLatestSnapshot } from '../repository/persistence';
import { buildHookResult } from './signalEngineHooks';
import { decideActions, type ActionDecision } from '../actions/actionRegistry';
import { db } from '@/lib/db';

export interface AppliedPenalty {
  signal: QuantSignal;
  hook: ManipulationHookResult;
  confidencePenalty: number;
  riskPenalty: number;
  rejected: boolean;
  warning: string | null;
  /** Snapshot id resolved from the DB; 0 if no snapshot exists. */
  snapshotId: number;
  /** Phase 3: full action decision (which bounded actions fired). */
  decision?: ActionDecision;
}

/**
 * Optional behavior switches for penalty application.
 *
 * `override: true` — used for manually-promoted signals. Skips the
 * confidence/risk/status mutation entirely, but still attaches a
 * non-blocking warning so the audit trail shows the suspicion was
 * seen and consciously ignored. Caller is responsible for recording
 * who authorised the override.
 */
export interface ApplyHookOptions {
  override?: boolean;
}

/**
 * Pure penalty math — no DB. Returns the mutated signal plus the
 * numeric penalty applied so the caller can log it.
 */
export function applyHookToSignal(
  signal: QuantSignal,
  hook: ManipulationHookResult,
  opts: ApplyHookOptions = {},
): Omit<AppliedPenalty, 'snapshotId'> {
  // Manual override: leave the signal untouched but surface a warning
  // so reviewers can see that the engine did flag it.
  if (opts.override) {
    const warning =
      hook.band === 'low'
        ? null
        : `Manual override: ${hook.band} manipulation suspicion (${hook.score}/100) not applied`;
    if (warning) signal.warnings = [...signal.warnings, warning];
    return {
      signal,
      hook,
      confidencePenalty: 0,
      riskPenalty: 0,
      rejected: false,
      warning,
      decision: {
        band: hook.band,
        actions: [],
        confidenceDelta: 0,
        riskDelta: 0,
        rankDelta: 0,
        suppress: false,
        manualReview: true,
      },
    };
  }

  // Phase 3: policy lives in the action registry, not here.
  const decision = decideActions(hook.band);

  let warning: string | null = null;
  if (hook.band === 'watch') {
    warning = `Manipulation watch: score ${hook.score}/100`;
  } else if (decision.actions.length > 0) {
    const prefix = hook.band.charAt(0).toUpperCase() + hook.band.slice(1);
    warning = hook.warning ?? `${prefix} manipulation suspicion (${hook.score}/100)`;
    if (decision.suppress) warning += ' — signal suppressed';
  }

  // Mutate the signal. Confidence floors at 0; risk caps at 100.
  signal.confidenceScore = Math.max(0, signal.confidenceScore - decision.confidenceDelta);
  signal.riskScore = Math.min(100, signal.riskScore + decision.riskDelta);
  if (warning) signal.warnings = [...signal.warnings, warning];
  if (decision.suppress) signal.status = 'invalidated';

  return {
    signal,
    hook,
    confidencePenalty: decision.confidenceDelta,
    riskPenalty: decision.riskDelta,
    rejected: decision.suppress,
    warning,
    decision,
  };
}

/**
 * DB-aware variant. Looks up the latest snapshot for the symbol,
 * applies the penalty math, and returns the snapshot id so callers
 * can persist a penalty row after the signal itself is saved.
 */
export async function applyManipulationPenalty(
  signal: QuantSignal,
  opts: ApplyHookOptions = {},
): Promise<AppliedPenalty> {
  const snapshot = await loadLatestSnapshot(signal.symbol);
  const hook = buildHookResult(snapshot, signal.symbol);
  const result = applyHookToSignal(signal, hook, opts);

  let snapshotId = 0;
  if (snapshot) {
    const { rows } = await db.query<{ id: number }>(
      `SELECT id FROM q365_manipulation_snapshots WHERE symbol = ? AND snapshot_date = ? LIMIT 1`,
      [snapshot.symbol, snapshot.snapshotDate],
    );
    snapshotId = (rows[0] as any)?.id ?? 0;
  }

  return { ...result, snapshotId };
}

/**
 * Build a penalty record from an AppliedPenalty + the persisted signal id.
 * Caller decides whether to actually write it (skip if no penalty).
 */
export function buildPenaltyRecord(
  applied: AppliedPenalty,
  signalDbId: number,
): ManipulationPenaltyRecord | null {
  if (applied.confidencePenalty === 0 && applied.riskPenalty === 0 && !applied.rejected) {
    return null;
  }
  if (applied.snapshotId === 0) return null;
  return {
    signalId: String(signalDbId),
    snapshotId: applied.snapshotId,
    confidencePenalty: applied.confidencePenalty,
    riskPenalty: applied.riskPenalty,
    rejectionFlag: applied.rejected,
    reason: applied.warning ?? `band=${applied.hook.band} score=${applied.hook.score}`,
  };
}
