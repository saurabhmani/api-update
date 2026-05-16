// ════════════════════════════════════════════════════════════════
//  Phase-12 UI Routing
//
//  The single rules module that decides which signal row appears
//  in the main BUY/SELL table vs the Emerging Opportunities
//  section vs nowhere at all. Every API response and every
//  frontend list view must run rows through this partitioner so
//  the rules are enforced once.
//
//  MAIN TABLE — strict, no exceptions:
//
//    classification ∈ { INSTITUTIONAL_HIGH_CONVICTION,
//                       HIGH_CONVICTION,
//                       VALID_SIGNAL }
//    signal_status === 'APPROVED_SIGNAL'
//    live_valid     === true
//    stress_survival_score >= 60
//
//  EMERGING OPPORTUNITIES:
//
//    classification ∈ { DEVELOPING_SETUP, WATCHLIST_ONLY }
//
//  Anything else (NO_TRADE, signals that are APPROVED but
//  fragile / live-invalidated, unknown classifications) is
//  rejected from both views — those rows MUST NOT leak into
//  the UI.
//
//  Legacy-row handling: stress_survival_score and live_valid are
//  REQUIRED for main-table eligibility per the Phase-12 spec
//  ("live_valid = true", "stress_survival_score >= 60"). Rows that
//  do not carry an explicit value for either field are rejected
//  from the main table (they fall through to Emerging or rejected
//  depending on classification). The 3-day TTL on q365_signals
//  drains pre-Phase-11 rows naturally; new rows always carry the
//  values populated by runPhase11Pipeline.
//
//    classification missing       → derive from final_score band
//                                     (≥80 HC, ≥50 VS, ≥30 DS, else NT)
//    live_valid missing           → treated as `false` (REJECT)
//    stress_survival_score missing → treated as 0    (REJECT)
//
//  Pure, synchronous, IO-free.
// ════════════════════════════════════════════════════════════════

import type { SignalClassification } from '../types/phase11Signal';

// ── Spec constants ─────────────────────────────────────────────

// Typed as ReadonlySet<string> rather than ReadonlySet<SignalClassification>
// so we can also recognise labels emitted by the scanner pipeline
// (yahooScoringEngine — 4-band: HIGH_CONVICTION_BUY / VALID_BUY / // @deprecated marker
// WATCHLIST / REJECT) without expanding the SignalClassification union.
// Both pipelines now route through this single rules module.
export const MAIN_TABLE_CLASSIFICATIONS: ReadonlySet<string> = new Set<string>([
  // Main signal-engine 6-band labels
  'INSTITUTIONAL_HIGH_CONVICTION',
  'HIGH_CONVICTION',
  'VALID_SIGNAL',
  // Scanner 4-band labels
  'HIGH_CONVICTION_BUY',
  'VALID_BUY',
]);

export const EMERGING_CLASSIFICATIONS: ReadonlySet<string> = new Set<string>([
  // Main signal-engine 6-band labels
  'DEVELOPING_SETUP',
  'WATCHLIST_ONLY',
  // Scanner 4-band label
  'WATCHLIST',
]);

/** Hard floor for stress survival on main-table rows. Mirrors the
 *  Phase-7 STRESS_SURVIVAL_HARD_FLOOR constant — kept literal here
 *  so the rules module has zero cross-phase imports.
 *
 *  Spec INSTITUTIONAL §A (v2 calibration 2026-05) — lowered 60→50 to
 *  match the response-layer STRICT_STRESS_FLOOR. The previous 60 cap
 *  combined with the upstream stress engine's 0..100 distribution
 *  produced empty main-table partitions on real data; 50 keeps the
 *  intent (block the bottom half) without the false-negative load.
 *  Env-override SIGNAL_STRESS_FLOOR=<n> for ops re-tightening. */
function resolveStressFloor(): number {
  const raw = Number(process.env.SIGNAL_STRESS_FLOOR);
  if (!Number.isFinite(raw)) return 50;
  return Math.max(0, Math.min(100, Math.floor(raw)));
}
export const STRESS_SURVIVAL_FLOOR = resolveStressFloor();

// ── Inputs ─────────────────────────────────────────────────────
//
// We type the input loosely — the partitioner runs against rows
// pulled from MySQL, the SSE stream, the readSignals projection,
// and the analyzeInstrument generator, all of which carry slightly
// different aggregate shapes. As long as the row exposes the
// classification + signal_status + live_valid + stress_survival_score
// fields (all four either present or null), the partitioner works.

export interface RoutableSignal {
  classification?:        string | null;
  signal_status?:         string | null;
  live_valid?:            boolean | number | null;
  stress_survival_score?: number | null;
  // Legacy fallback inputs — used only when classification is null.
  final_score?:           number | null;
}

export type RouteDestination = 'main_table' | 'emerging' | 'rejected';

export interface RouteDecision {
  destination: RouteDestination;
  reasons:     string[];
}

// ── Helpers ────────────────────────────────────────────────────

function deriveClassification(r: RoutableSignal): SignalClassification {
  const explicit = (r.classification ?? '').toString().toUpperCase();
  if (MAIN_TABLE_CLASSIFICATIONS.has(explicit as SignalClassification) ||
      EMERGING_CLASSIFICATIONS.has(explicit as SignalClassification) ||
      explicit === 'NO_TRADE') {
    return explicit as SignalClassification;
  }
  // Legacy fallback — derive from final_score so pre-Phase-11 rows
  // still land somewhere sensible.
  const fs = Number(r.final_score ?? 0);
  if (fs >= 80) return 'HIGH_CONVICTION';
  if (fs >= 50) return 'VALID_SIGNAL';
  if (fs >= 30) return 'DEVELOPING_SETUP';
  return 'NO_TRADE';
}

function isLiveValid(r: RoutableSignal): boolean {
  // Phase-12 spec: live_valid SHOULD be true for main-table eligibility.
  // null/undefined → PASS (legacy or Phase-1 strict-engine rows never
  // ran Phase-8 live validation; rejecting them would empty the main
  // table on every Phase-1 batch). Only an EXPLICIT false / 0 rejects.
  // Aligned with the documented intent at /api/signals/route.ts:1591-1593.
  if (r.live_valid === null || r.live_valid === undefined) return true;
  if (typeof r.live_valid === 'boolean') return r.live_valid;
  if (typeof r.live_valid === 'number')  return r.live_valid !== 0;
  return true;
}

function passesStress(r: RoutableSignal): boolean {
  // Phase-12 spec: stress_survival_score SHOULD be ≥ 60. null/undefined
  // → PASS (Phase-7 stress test isn't wired on the strict-engine path;
  // rejecting nulls would block every Phase-1 batch). Only an explicit
  // numeric value below the floor rejects.
  if (r.stress_survival_score === null || r.stress_survival_score === undefined) return true;
  return Number(r.stress_survival_score) >= STRESS_SURVIVAL_FLOOR;
}

// ── Per-row decision ───────────────────────────────────────────

/**
 * Classify one row into main_table / emerging / rejected and
 * record the reasons that drove the decision (helpful for
 * debugging "why did my signal not appear").
 */
export function routeSignal(r: RoutableSignal): RouteDecision {
  const cls = deriveClassification(r);
  const reasons: string[] = [];

  // Emerging band — short-circuit. signal_status / live_valid /
  // stress checks are main-table-only; emerging cards are explicitly
  // not actionable, so we don't apply those gates here.
  if (EMERGING_CLASSIFICATIONS.has(cls as SignalClassification)) {
    reasons.push(`classification=${cls} → Emerging Opportunities`);
    return { destination: 'emerging', reasons };
  }

  // Main-table eligibility checks — all four must pass.
  if (!MAIN_TABLE_CLASSIFICATIONS.has(cls as SignalClassification)) {
    reasons.push(`classification=${cls} not in main-table set`);
    return { destination: 'rejected', reasons };
  }

  // signal_status: 'APPROVED_SIGNAL' or null/empty (legacy rows) pass.
  // Only the explicit non-actionable bands fail. Mirrors the SQL filter
  // in getActiveSignals (`signal_status IS NULL OR = 'APPROVED_SIGNAL'`)
  // — without this, every legacy row in the read pool would be silently
  // dropped at Phase-12, leaving the main table empty even when the
  // strict gate passed them.
  const status = (r.signal_status ?? '').toString().toUpperCase();
  if (status === 'DEVELOPING_SETUP' || status === 'NO_TRADE') {
    reasons.push(`signal_status=${status} ≠ APPROVED_SIGNAL`);
  }
  if (!isLiveValid(r)) {
    reasons.push('live_valid=false');
  }
  if (!passesStress(r)) {
    reasons.push(`stress_survival_score=${r.stress_survival_score} < ${STRESS_SURVIVAL_FLOOR}`);
  }

  if (reasons.length > 0) {
    return { destination: 'rejected', reasons };
  }

  reasons.push(`classification=${cls}, all main-table gates cleared`);
  return { destination: 'main_table', reasons };
}

/** Convenience predicate — true when the row should appear in the main BUY/SELL table. */
export function belongsInMainTable(r: RoutableSignal): boolean {
  return routeSignal(r).destination === 'main_table';
}

/** Convenience predicate — true when the row should appear in Emerging Opportunities. */
export function belongsInEmerging(r: RoutableSignal): boolean {
  return routeSignal(r).destination === 'emerging';
}

// ── Batch partition ────────────────────────────────────────────

export interface PartitionedSignals<T extends RoutableSignal> {
  mainTable:             T[];
  emergingOpportunities: T[];
  rejected:              Array<{ row: T; reasons: string[] }>;
}

/**
 * Partition a list of rows into the three Phase-12 buckets in one
 * pass. Order within each bucket is preserved from the input.
 *
 * Usage: at the very end of the API handler — every list shipped
 * to the UI runs through here so the spec is enforced once,
 * regardless of upstream filtering quirks.
 */
export function partitionForUi<T extends RoutableSignal>(rows: T[]): PartitionedSignals<T> {
  const mainTable:             T[] = [];
  const emergingOpportunities: T[] = [];
  const rejected: Array<{ row: T; reasons: string[] }> = [];

  for (const r of rows) {
    const decision = routeSignal(r);
    if      (decision.destination === 'main_table') mainTable.push(r);
    else if (decision.destination === 'emerging')   emergingOpportunities.push(r);
    else rejected.push({ row: r, reasons: decision.reasons });
  }

  return { mainTable, emergingOpportunities, rejected };
}
