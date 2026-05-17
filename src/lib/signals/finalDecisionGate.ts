// ════════════════════════════════════════════════════════════════
//  Institutional Final Decision Gate — Phase 3 + 5 + 6 closure
//
//  Applies regime, confirmation, conflict, manipulation, and
//  execution intelligence as a FINAL effective-status layer over
//  the row's raw approval/classification.
//
//  Critical safety rules:
//   - Can only DEMOTE. Never promotes a row through hard blockers.
//     APPROVED can become WATCHLIST or REJECTED; WATCHLIST can
//     become REJECTED; REJECTED stays REJECTED.
//   - Preserves the raw status — never overwrites the DB-side value.
//     Exposes parallel `rawApprovalStatus` / `effectiveApprovalStatus`
//     fields so the operator sees both the original truth and the
//     institutional verdict.
//   - Every demotion adds a structured trace entry so the operator
//     can replay exactly why the effective status differs from raw.
//
//  Pure module — no I/O. Caller hands in the intelligence the row
//  was enriched with; the gate combines them into a decision.
// ════════════════════════════════════════════════════════════════

import type {
  StrategyRoutingDecision,
  RoutedRegime,
} from '@/lib/strategies/regimeRouter';
import type {
  ApprovalRecommendation,
  ModuleStatus,
  ConfirmationAggregate,
} from '@/lib/confirmation/confirmationAggregator';
import type {
  ConflictStatus,
  ConflictResolution,
} from '@/lib/strategies/conflictResolver';

// ── Public types ──────────────────────────────────────────────

export type RawAction = 'APPROVED' | 'WATCHLIST' | 'REJECTED' | 'AVOID';

export interface DecisionTraceEntry {
  /** Which intelligence layer produced this entry. */
  layer:    'freshness' | 'regime' | 'confirmation' | 'conflict' | 'manipulation' | 'execution' | 'baseline';
  /** Single short reason for the operator. */
  reason:   string;
  /** Severity used by the gate to decide whether to demote. */
  severity: 'blocker' | 'warning' | 'info';
  /** Optional structured payload (e.g. routing decision, conflict status). */
  meta?:    Record<string, unknown>;
}

export interface FinalDecision {
  rawAction:                RawAction;
  rawApprovalStatus:        RawAction;
  effectiveAction:          RawAction;
  effectiveApprovalStatus:  RawAction;
  decisionChanged:          boolean;
  /** Plain-language reason if the gate demoted; null when unchanged. */
  demotionReason:           string | null;
  /** Hard blockers — these forbid APPROVED entirely. */
  institutionalBlockers:    string[];
  /** Soft warnings — surfaced but don't force a demotion. */
  institutionalWarnings:    string[];
  /** Ordered audit trace of every contribution. */
  decisionTrace:            DecisionTraceEntry[];
}

export interface DecisionGateInput {
  /** Existing row classification. */
  rawAction:               RawAction | null;
  /** Freshness state from the row (e.g. 'fresh' | 'stale' | 'expired'). */
  freshnessState:          string | null;
  /** Did the upstream gates already mark the row stale? */
  isStaleData:             boolean;
  /** Phase 3 — per-strategy routing decision. */
  routing?:                StrategyRoutingDecision | null;
  /** Current regime label (snake_case). */
  currentRegime?:          RoutedRegime | null;
  /** Phase 5 — confirmation aggregate envelope. */
  confirmation?:           ConfirmationAggregate | null;
  /** Phase 5 — execution-module status. */
  executionStatus?:        ModuleStatus | null;
  /** Phase 5 — manipulation-module status + band. */
  manipulationStatus?:     ModuleStatus | null;
  manipulationBand?:       'LOW' | 'MEDIUM' | 'HIGH' | 'SEVERE' | 'UNKNOWN' | null;
  /** Phase 6 — conflict resolver output. */
  conflict?:               ConflictResolution | null;
  /** Optional flag if the row already had a structural risk-reward
   *  problem the strict gate caught (saves the gate from re-deriving). */
  riskRewardInvalid?:      boolean;
}

// ── Internals ─────────────────────────────────────────────────

function severityRank(a: RawAction): number {
  switch (a) {
    case 'APPROVED':  return 3;
    case 'WATCHLIST': return 2;
    case 'REJECTED':  return 1;
    case 'AVOID':     return 0;
  }
}

/** Returns the more conservative of two actions (lower severity). */
function moreConservative(a: RawAction, b: RawAction): RawAction {
  return severityRank(b) < severityRank(a) ? b : a;
}

/** Demote APPROVED → WATCHLIST, leave the rest alone. */
function demoteApprovedToWatchlist(a: RawAction): RawAction {
  return a === 'APPROVED' ? 'WATCHLIST' : a;
}

/** Demote APPROVED/WATCHLIST → REJECTED. */
function rejectActionable(a: RawAction): RawAction {
  return a === 'APPROVED' || a === 'WATCHLIST' ? 'REJECTED' : a;
}

// ── Public entry point ────────────────────────────────────────

export function applyInstitutionalDecisionGate(
  input: DecisionGateInput,
): FinalDecision {
  const trace: DecisionTraceEntry[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  const raw: RawAction = (input.rawAction ?? 'WATCHLIST');
  trace.push({
    layer: 'baseline',
    reason: `Raw status: ${raw}`,
    severity: 'info',
  });

  let effective: RawAction = raw;

  // ── 1. Freshness gate ──
  //
  // Stale or pending validation forbids APPROVED entirely. Demotes to
  // WATCHLIST at most — REJECTED only if the strict gate already said so.
  const stale = input.isStaleData === true ||
    /stale|expired|pending/i.test(String(input.freshnessState ?? ''));
  if (stale) {
    if (effective === 'APPROVED') {
      effective = 'WATCHLIST';
      trace.push({
        layer: 'freshness',
        reason: 'Signal approval restricted because latest candle validation is pending.',
        severity: 'blocker',
      });
      blockers.push('Signal approval restricted because latest candle validation is pending.');
    } else {
      trace.push({
        layer: 'freshness',
        reason: 'Data freshness is degraded — interpret signal with caution.',
        severity: 'warning',
      });
      warnings.push('Data freshness is degraded — interpret signal with caution.');
    }
  }

  // ── 2. Regime gate ──
  const r = input.routing ?? null;
  if (r) {
    switch (r.routingDecision) {
      case 'BLOCK': {
        const next = rejectActionable(effective);
        if (next !== effective) {
          trace.push({ layer: 'regime', reason: r.reason, severity: 'blocker',
            meta: { routingDecision: 'BLOCK', regime: input.currentRegime } });
          blockers.push(`Approval restricted by current market regime: ${r.reason}`);
        }
        effective = moreConservative(effective, next);
        break;
      }
      case 'WATCHLIST_ONLY': {
        const next = demoteApprovedToWatchlist(effective);
        if (next !== effective) {
          trace.push({ layer: 'regime',
            reason: `Watchlist only: current ${input.currentRegime ?? 'regime'} does not support approval for this strategy.`,
            severity: 'blocker',
            meta: { routingDecision: 'WATCHLIST_ONLY', regime: input.currentRegime } });
          blockers.push(`Watchlist only: current regime does not support approval for this strategy.`);
        }
        effective = moreConservative(effective, next);
        break;
      }
      case 'REDUCE': {
        // REDUCE is a confidence haircut, not a demotion. Warning only.
        warnings.push('Confidence reduced by current market regime.');
        trace.push({ layer: 'regime', reason: r.reason, severity: 'warning',
          meta: { routingDecision: 'REDUCE' } });
        break;
      }
      case 'PROMOTE':
      case 'ACTIVE': {
        // Promote / Active never overrides freshness/risk blockers.
        // Add an info entry so the trace shows the supportive layer.
        trace.push({ layer: 'regime', reason: r.reason, severity: 'info',
          meta: { routingDecision: r.routingDecision } });
        break;
      }
      case 'INSUFFICIENT_DATA': {
        // Treat as WATCHLIST_ONLY (spec: stricter when regime is unknown).
        const next = demoteApprovedToWatchlist(effective);
        if (next !== effective) {
          trace.push({ layer: 'regime',
            reason: 'Watchlist only: market regime is undetermined.',
            severity: 'blocker',
            meta: { routingDecision: 'INSUFFICIENT_DATA' } });
          blockers.push('Watchlist only: market regime is undetermined.');
        }
        effective = moreConservative(effective, next);
        break;
      }
    }
  }

  // ── 3. Confirmation gate ──
  const c = input.confirmation ?? null;
  if (c) {
    switch (c.approvalRecommendation as ApprovalRecommendation) {
      case 'AVOID': {
        const next: RawAction = 'AVOID';
        trace.push({ layer: 'confirmation', reason: c.blockers[0] ?? c.explanation,
          severity: 'blocker', meta: { recommendation: 'AVOID' } });
        blockers.push(`Confirmation says AVOID: ${c.blockers[0] ?? 'critical confirmation module reported a block.'}`);
        effective = moreConservative(effective, next);
        break;
      }
      case 'REJECT': {
        const next = rejectActionable(effective);
        if (next !== effective) {
          trace.push({ layer: 'confirmation', reason: c.blockers[0] ?? c.explanation,
            severity: 'blocker', meta: { recommendation: 'REJECT' } });
          blockers.push(`Confirmation says REJECT: ${c.blockers[0] ?? 'confirmation gate failed.'}`);
        }
        effective = moreConservative(effective, next);
        break;
      }
      case 'WATCHLIST': {
        const next = demoteApprovedToWatchlist(effective);
        if (next !== effective) {
          trace.push({ layer: 'confirmation', reason: c.explanation, severity: 'blocker',
            meta: { recommendation: 'WATCHLIST', score: c.confirmationScore } });
          blockers.push(`Watchlist only: confirmation score is below approval threshold.`);
        }
        effective = moreConservative(effective, next);
        break;
      }
      case 'APPROVE':
      case 'INSUFFICIENT_DATA':
        // APPROVE never promotes a non-approved row; INSUFFICIENT_DATA
        // is neutral on its own (other gates decide).
        trace.push({ layer: 'confirmation',
          reason: c.explanation,
          severity: 'info',
          meta: { recommendation: c.approvalRecommendation, score: c.confirmationScore } });
        break;
    }
  }

  // ── 4. Conflict gate ──
  const conflict = input.conflict ?? null;
  if (conflict) {
    if (conflict.conflictStatus === 'HIGH') {
      const next = demoteApprovedToWatchlist(effective);
      if (next !== effective) {
        trace.push({ layer: 'conflict',
          reason: `Watchlist only: strategy conflict detected — ${conflict.decisionImpact}`,
          severity: 'blocker',
          meta: { conflictStatus: 'HIGH', dominantView: conflict.dominantView } });
        blockers.push(`Watchlist only: strategy conflict detected.`);
      }
      effective = moreConservative(effective, next);
    } else if (conflict.conflictStatus === 'MEDIUM') {
      warnings.push('Strategy conflict at MEDIUM severity — approval confidence reduced.');
      trace.push({ layer: 'conflict',
        reason: conflict.explanation,
        severity: 'warning',
        meta: { conflictStatus: 'MEDIUM' } });
    }
  }

  // ── 5. Manipulation / trap risk gate ──
  if (input.manipulationBand === 'SEVERE') {
    const next: RawAction = 'AVOID';
    trace.push({ layer: 'manipulation',
      reason: 'Severe manipulation / trap risk — avoid.',
      severity: 'blocker', meta: { band: 'SEVERE' } });
    blockers.push('Approval restricted due to severe trap/manipulation risk.');
    effective = moreConservative(effective, next);
  } else if (input.manipulationBand === 'HIGH') {
    const next = demoteApprovedToWatchlist(effective);
    if (next !== effective) {
      trace.push({ layer: 'manipulation',
        reason: 'Approval restricted due to elevated trap/manipulation risk.',
        severity: 'blocker', meta: { band: 'HIGH' } });
      blockers.push('Approval restricted due to elevated trap/manipulation risk.');
    }
    effective = moreConservative(effective, next);
  } else if (input.manipulationStatus === 'WEAK') {
    warnings.push('Mild manipulation signature observed — proceeding with caution.');
    trace.push({ layer: 'manipulation', reason: 'Mild manipulation signature observed.',
      severity: 'warning' });
  }

  // ── 6. Execution-quality gate ──
  if (input.executionStatus === 'BLOCKED' || input.riskRewardInvalid === true) {
    const next = demoteApprovedToWatchlist(effective);
    if (next !== effective) {
      trace.push({ layer: 'execution',
        reason: 'Execution quality blocked approval because stop-loss or risk-reward is structurally invalid.',
        severity: 'blocker' });
      blockers.push('Execution quality blocked approval because stop-loss or risk-reward is structurally invalid.');
    }
    effective = moreConservative(effective, next);
  } else if (input.executionStatus === 'WEAK') {
    // Soft demotion: only demote APPROVED when execution is WEAK; otherwise warn.
    const next = demoteApprovedToWatchlist(effective);
    if (next !== effective) {
      trace.push({ layer: 'execution',
        reason: 'Execution quality is below approval threshold — watchlist only.',
        severity: 'blocker' });
      blockers.push('Execution quality is below approval threshold.');
    }
    effective = moreConservative(effective, next);
  }

  // ── Compose result ──
  const decisionChanged = effective !== raw;
  const demotionReason: string | null = decisionChanged
    ? blockers[0] ?? 'Effective status was demoted by the institutional decision gate.'
    : null;

  return {
    rawAction:               raw,
    rawApprovalStatus:       raw,
    effectiveAction:         effective,
    effectiveApprovalStatus: effective,
    decisionChanged,
    demotionReason,
    institutionalBlockers:   blockers,
    institutionalWarnings:   warnings,
    decisionTrace:           trace,
  };
}
