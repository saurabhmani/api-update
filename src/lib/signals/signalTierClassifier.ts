// ════════════════════════════════════════════════════════════════
//  signalTierClassifier — INSTITUTIONAL_TIER_2026-05
//
//  Partitions the rows the response builder produced into the five
//  professional tiers the new dashboard renders:
//
//    Tier 1  EXECUTION_READY      → signals[]            (APPROVED tab)
//    Tier 2  AWAITING_CONFIRMATION → developing[]         (Developing tab)
//    Tier 3  EMERGING_OPPORTUNITY  → scanner_candidates[] (Scanner tab)
//    Tier 4  MONITOR               → watchlist[]          (Watchlist tab)
//    Tier 5  RISK_RESTRICTED       → risk_restricted[]    (Risk tab)
//
//  Pure module — no I/O, no DB. Same input → same output.
//
//  The strict gate upstream (strictApproved + applyEliteGate) already
//  filters most of the work. This classifier is a SAFETY NET for the
//  legacy fallback paths in the route handler that can still inject
//  weaker rows into signals[] (closed-market relaxed override,
//  scanner-candidate promotion, best-available fallback). After this
//  pass, signals[] is guaranteed to contain only execution-ready
//  institutional rows; everything else moves to its proper tier.
// ════════════════════════════════════════════════════════════════

import {
  STRICT_CONFIDENCE_FLOOR,
  STRICT_FINAL_FLOOR,
  STRICT_RR_FLOOR,
} from '@/lib/signals/confirmedSignalPolicy';

/** Stable tier labels exposed on the wire for the new dashboard. */
export type SignalTier =
  | 'EXECUTION_READY'        // Tier 1 — main APPROVED table
  | 'HIGH_POTENTIAL'         // Tier 1.5 — fallback "conditional approval"
  | 'AWAITING_CONFIRMATION'  // Tier 2 — developing setups
  | 'EMERGING_OPPORTUNITY'   // Tier 3 — scanner candidates
  | 'MONITOR'                // Tier 4 — watchlist only
  | 'RISK_RESTRICTED';       // Tier 5 — blocked / vetoed / invalidated

export interface TieredRow {
  /** Wire-level tier discriminator. Frontend renders by this field. */
  tier?: SignalTier;
  /** True when the row was promoted via the high-potential fallback
   *  layer (Tier 1.5). The frontend renders a "Conditional Approval"
   *  badge on these rows so users know they cleared softer floors. */
  is_conditional?: boolean | null;
  // Optional factor scores consulted by the high-potential scorer.
  // Most q365_signals rows do not yet carry the full factor breakdown;
  // the scorer treats missing values as neutral (no boost, no penalty)
  // so a row with only confidence/final/RR can still rank.
  liquidity_score?:        number | null;
  portfolio_fit_score?:    number | null;
  stress_survival_score?:  number | null;
  market_regime_score?:    number | null;
  // Discriminating fields — all optional because legacy callers don't
  // populate every row with every field. The classifier reads what's
  // present and falls back to the safest tier when ambiguous.
  symbol?:                string | null;
  tradingsymbol?:         string | null;
  classification?:        string | null;
  raw_classification?:    string | null;
  signal_status?:         string | null;
  status?:                string | null;
  execution_allowed?:     boolean | null;
  is_relaxed?:            boolean | null;
  is_scanner_candidate?:  boolean | null;
  is_demoted?:            boolean | null;
  is_developing_setup?:   boolean | null;
  live_invalidated?:      boolean | null;
  invalidation_reason?:   string | null;
  tradeability_status?:   string | null;
  freshness_state?:       string | null;
  decay_state?:           string | null;
  confidence_score?:      number | null;
  confidence?:            number | null;
  final_score?:           number | null;
  rr_ratio?:              number | null;
  risk_reward?:           number | null;
}

const APPROVED_CLASSIFICATIONS = new Set<string>([
  'EXECUTION_READY',
  'INSTITUTIONAL_HIGH_CONVICTION',
  'HIGH_CONVICTION',
  'HIGH_CONVICTION_BUY',
  'VALID_SIGNAL',
  'VALID_BUY',
]);

const APPROVED_SIGNAL_STATUSES = new Set<string>([
  'APPROVED_SIGNAL',
  'VALID_SIGNAL',
]);

const WATCHLIST_CLASSIFICATIONS = new Set<string>([
  'WATCHLIST_ONLY',
  'WATCHLIST',
]);

const DEVELOPING_VALUES = new Set<string>([
  'DEVELOPING_SETUP',
  'DEVELOPING',
  'AWAITING_CONFIRMATION',
]);

const TERMINAL_LIFECYCLE = new Set<string>([
  'INVALIDATED', 'EXPIRED', 'STOP_LOSS_HIT', 'TARGET_HIT',
  'CLOSED', 'TERMINATED', 'CANCELLED', 'REJECTED',
]);

const FORBIDDEN_FRESHNESS = new Set<string>([
  'STALE', 'EXPIRED',
]);

const FORBIDDEN_DECAY = new Set<string>([
  'stale', 'expired', 'STALE', 'EXPIRED',
]);

/** True when a row meets every institutional bar for the APPROVED tab.
 *  This is the contract: signal_status, classification, execution_allowed,
 *  is_relaxed=false, live_invalidated=false, confidence ≥ floor,
 *  tradeability_status ≠ blocked, no stale freshness/decay tags. */
export function isExecutionReady(r: TieredRow): boolean {
  // Soft-flag rejections — these tags exist precisely to mark a row as
  // NOT execution-ready. The strict gate upstream may have set them.
  if (r.is_relaxed === true)            return false;
  if (r.is_scanner_candidate === true)  return false;
  if (r.is_demoted === true)            return false;
  if (r.is_developing_setup === true)   return false;
  if (r.live_invalidated === true)      return false;
  if (r.invalidation_reason && String(r.invalidation_reason).trim() !== '') {
    return false;
  }
  if (r.execution_allowed === false)    return false;

  const tradeability = String(r.tradeability_status ?? '').toLowerCase();
  if (tradeability === 'blocked' || tradeability === 'restricted') return false;

  const lifecycle = String(r.status ?? '').toUpperCase();
  if (lifecycle && TERMINAL_LIFECYCLE.has(lifecycle)) return false;

  const fresh = String(r.freshness_state ?? '').toUpperCase();
  if (fresh && FORBIDDEN_FRESHNESS.has(fresh)) return false;

  const decay = String(r.decay_state ?? '');
  if (decay && FORBIDDEN_DECAY.has(decay)) return false;

  const ss = String(r.signal_status ?? '').toUpperCase();
  // Empty signal_status is permitted only for confirmed snapshot rows
  // (which set classification but not signal_status). When set, it
  // must be APPROVED/VALID.
  if (ss && !APPROVED_SIGNAL_STATUSES.has(ss)) return false;

  const cls    = String(r.classification ?? '').toUpperCase();
  const rawCls = String(r.raw_classification ?? '').toUpperCase().trim();
  const eligibleCls =
    APPROVED_CLASSIFICATIONS.has(cls)
    || (rawCls !== '' && APPROVED_CLASSIFICATIONS.has(rawCls));
  if (!eligibleCls) return false;

  // Numeric floors — defensively re-check against the strict floor so
  // a row that escaped the strict gate via a fallback path still
  // can't enter APPROVED.
  const cs = Number(r.confidence_score ?? r.confidence ?? NaN);
  if (!Number.isFinite(cs) || cs < STRICT_CONFIDENCE_FLOOR) return false;
  const fs = Number(r.final_score ?? NaN);
  if (Number.isFinite(fs) && fs < STRICT_FINAL_FLOOR) return false;
  const rr = Number(r.rr_ratio ?? r.risk_reward ?? NaN);
  if (Number.isFinite(rr) && rr < STRICT_RR_FLOOR) return false;

  return true;
}

/** Soft tier — a row that's tracking toward APPROVED but isn't there
 *  yet (relaxed-tier surfaced, below-floor demoted, DEVELOPING_SETUP). */
export function isAwaitingConfirmation(r: TieredRow): boolean {
  if (r.is_relaxed === true)           return true;
  if (r.is_demoted === true)           return true;
  if (r.is_developing_setup === true)  return true;
  const ss  = String(r.signal_status ?? '').toUpperCase();
  const cls = String(r.classification ?? '').toUpperCase();
  if (DEVELOPING_VALUES.has(ss))  return true;
  if (DEVELOPING_VALUES.has(cls)) return true;
  return false;
}

/** Pure scanner output — engine flagged a stock but maturity gates
 *  haven't run / haven't promoted. */
export function isEmergingOpportunity(r: TieredRow): boolean {
  if (r.is_scanner_candidate === true) return true;
  // Scanner-tagged rows often carry freshness_state='STALE' alongside
  // is_scanner_candidate=true; the explicit flag above already catches
  // them. No additional heuristic needed here.
  return false;
}

/** Watchlist-only rows — the engine is tracking the symbol but it
 *  hasn't generated an actionable setup. */
export function isMonitor(r: TieredRow): boolean {
  const cls    = String(r.classification ?? '').toUpperCase();
  const rawCls = String(r.raw_classification ?? '').toUpperCase().trim();
  const ss     = String(r.signal_status ?? '').toUpperCase();
  if (WATCHLIST_CLASSIFICATIONS.has(cls))    return true;
  if (rawCls && WATCHLIST_CLASSIFICATIONS.has(rawCls)) return true;
  if (WATCHLIST_CLASSIFICATIONS.has(ss))     return true;
  return false;
}

/** Hard veto — invalidated, blocked, or terminal lifecycle. These are
 *  explicitly NOT tradable. */
export function isRiskRestricted(r: TieredRow): boolean {
  if (r.live_invalidated === true) return true;
  if (r.invalidation_reason && String(r.invalidation_reason).trim() !== '') return true;
  if (r.execution_allowed === false) return true;
  const tradeability = String(r.tradeability_status ?? '').toLowerCase();
  if (tradeability === 'blocked' || tradeability === 'restricted') return true;
  const lifecycle = String(r.status ?? '').toUpperCase();
  if (lifecycle && TERMINAL_LIFECYCLE.has(lifecycle)) return true;
  return false;
}

/** Ordered tier resolution — the FIRST predicate that matches wins.
 *  Order matters: RISK_RESTRICTED is checked before MONITOR/AWAITING
 *  so an invalidated-yet-relaxed row stays in the risk bucket. */
export function classifyTier(r: TieredRow): SignalTier {
  // Execution-ready is the strictest predicate; reach for it first
  // because every other tier is a "downgrade from approved" reason.
  if (isExecutionReady(r))      return 'EXECUTION_READY';
  if (isRiskRestricted(r))      return 'RISK_RESTRICTED';
  if (isMonitor(r))             return 'MONITOR';
  if (isEmergingOpportunity(r)) return 'EMERGING_OPPORTUNITY';
  if (isAwaitingConfirmation(r))return 'AWAITING_CONFIRMATION';
  // Fallback — a row that doesn't satisfy any positive predicate but
  // also passed every veto goes to AWAITING_CONFIRMATION (the safest
  // non-actionable bucket). This ensures no row vanishes silently.
  return 'AWAITING_CONFIRMATION';
}

export interface TieredPartition<T extends TieredRow> {
  approved:           T[];  // Tier 1 — main signals[]
  developing:         T[];  // Tier 2
  scannerCandidates:  T[];  // Tier 3
  watchlist:          T[];  // Tier 4
  riskRestricted:     T[];  // Tier 5
}

/** Partition a heterogeneous row list into the five tiers. Each row is
 *  stamped with `tier` so downstream consumers can render without
 *  re-running the predicates. The function does NOT mutate input rows
 *  by reference — every output row is a shallow clone with the new
 *  field set. Empty input → empty output everywhere. */
export function partitionByTier<T extends TieredRow>(rows: readonly T[]): TieredPartition<T> {
  const out: TieredPartition<T> = {
    approved:          [],
    developing:        [],
    scannerCandidates: [],
    watchlist:         [],
    riskRestricted:    [],
  };
  for (const row of rows) {
    const tier = classifyTier(row);
    const stamped = { ...row, tier } as T;
    switch (tier) {
      case 'EXECUTION_READY':       out.approved.push(stamped);          break;
      case 'AWAITING_CONFIRMATION': out.developing.push(stamped);        break;
      case 'EMERGING_OPPORTUNITY':  out.scannerCandidates.push(stamped); break;
      case 'MONITOR':               out.watchlist.push(stamped);         break;
      case 'RISK_RESTRICTED':       out.riskRestricted.push(stamped);    break;
    }
  }
  return out;
}

/** Empty-state messaging — the new APPROVED tab must communicate
 *  WHY it's empty when other tiers have rows. The frontend reads
 *  `empty_state_message` and renders the banner over the empty list.
 *  When the conditional/high-potential fallback engaged, the message
 *  reflects that the dashboard is showing softer-floor candidates so
 *  the operator isn't misled into thinking these are fully confirmed. */
export function buildEmptyStateMessage(
  p: TieredPartition<TieredRow>,
  highPotentialCount = 0,
): string | null {
  if (p.approved.length > 0) return null;
  if (highPotentialCount > 0) {
    return `No fully confirmed signals. Showing ${highPotentialCount} strongest conditional opportunit${highPotentialCount === 1 ? 'y' : 'ies'}.`;
  }
  const parts: string[] = [];
  if (p.developing.length > 0) {
    parts.push(`${p.developing.length} setup${p.developing.length === 1 ? '' : 's'} awaiting confirmation`);
  }
  if (p.scannerCandidates.length > 0) {
    parts.push(`${p.scannerCandidates.length} emerging opportunit${p.scannerCandidates.length === 1 ? 'y' : 'ies'}`);
  }
  if (p.watchlist.length > 0) {
    parts.push(`${p.watchlist.length} on watchlist`);
  }
  if (parts.length === 0) {
    return 'No execution-ready signals — engine has not produced any candidates this cycle.';
  }
  return `No execution-ready signals. See ${parts.join(', ')} in the side tabs.`;
}

// ════════════════════════════════════════════════════════════════
//  CONDITIONAL_FALLBACK_2026-05 — high-potential promotion layer
//
//  When the strict APPROVED tier produces zero rows and the engine
//  has scanner / developing candidates that meet softer floors, we
//  promote the TOP 1–3 strongest into a Tier 1.5 "HIGH_POTENTIAL"
//  bucket so the main dashboard never feels dead while institutional
//  standards stay intact.
//
//  This is INTENTIONALLY narrower than the prior never-empty rule:
//   • Hard cap at 3 rows.
//   • Softer floors enforced (conf ≥ 60, RR ≥ 1.5).
//   • Fires only when signals[] is empty — never alongside.
//   • Promoted rows are stamped is_conditional=true so the frontend
//     can render a clear "Conditional Approval" badge.
//
//  Floors are env-overridable (SIGNAL_API_CONDITIONAL_*) so an
//  operator can re-tune without editing constants.
// ════════════════════════════════════════════════════════════════

const clampNum = (v: unknown, lo: number, hi: number): number => {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
};

const resolveCondFloor = (name: string, lo: number, hi: number, fallback: number): number => {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
};

/** Conditional confidence floor — softer than the strict 70 floor. */
export const CONDITIONAL_CONFIDENCE_FLOOR =
  resolveCondFloor('SIGNAL_API_CONDITIONAL_CONFIDENCE_FLOOR', 0, 100, 60);
/** Conditional RR floor. */
export const CONDITIONAL_RR_FLOOR =
  resolveCondFloor('SIGNAL_API_CONDITIONAL_RR_FLOOR', 0, 5, 1.5);
/** Acceptable-liquidity floor — applied only when the row carries
 *  a liquidity_score. Missing values are treated as neutral. */
export const CONDITIONAL_LIQUIDITY_FLOOR =
  resolveCondFloor('SIGNAL_API_CONDITIONAL_LIQUIDITY_FLOOR', 0, 100, 30);
/** Hard cap on the high-potential fallback set. */
export const HIGH_POTENTIAL_MAX_ROWS = Math.max(
  1, Math.min(5, Number(process.env.SIGNAL_API_HIGH_POTENTIAL_MAX) || 3),
);

/** Forbidden freshness/decay states for the conditional tier. STALE
 *  is acceptable per spec ("freshness not frozen"); FROZEN/EXPIRED
 *  is the hard reject. */
const CONDITIONAL_FORBIDDEN_FRESHNESS = new Set<string>([
  'FROZEN', 'EXPIRED',
]);
const CONDITIONAL_FORBIDDEN_DECAY = new Set<string>([
  'expired', 'EXPIRED', 'frozen', 'FROZEN',
]);

/** True when a row clears the conditional floors. Softer than strict
 *  but still institutional: live-validated, executable, fresh enough
 *  to act on. */
export function meetsConditionalFloors(r: TieredRow): boolean {
  // Hard vetoes first — these would disqualify the row from any tier.
  if (r.execution_allowed === false) return false;
  if (r.live_invalidated === true)   return false;
  if (r.invalidation_reason && String(r.invalidation_reason).trim() !== '') {
    return false;
  }
  const tradeability = String(r.tradeability_status ?? '').toLowerCase();
  if (tradeability === 'blocked' || tradeability === 'restricted') return false;
  const lifecycle = String(r.status ?? '').toUpperCase();
  if (lifecycle && TERMINAL_LIFECYCLE.has(lifecycle)) return false;

  // Freshness — STALE is fine, FROZEN/EXPIRED is not.
  const fresh = String(r.freshness_state ?? '').toUpperCase();
  if (fresh && CONDITIONAL_FORBIDDEN_FRESHNESS.has(fresh)) return false;
  const decay = String(r.decay_state ?? '');
  if (decay && CONDITIONAL_FORBIDDEN_DECAY.has(decay)) return false;

  // Soft numeric floors.
  const conf = Number(r.confidence_score ?? r.confidence ?? NaN);
  if (!Number.isFinite(conf) || conf < CONDITIONAL_CONFIDENCE_FLOOR) return false;
  const rr = Number(r.rr_ratio ?? r.risk_reward ?? NaN);
  if (!Number.isFinite(rr) || rr < CONDITIONAL_RR_FLOOR) return false;

  // Liquidity — applied only when the engine has scored it. A row
  // with no liquidity_score isn't penalised (most q365_signals rows
  // don't yet carry one).
  if (r.liquidity_score != null) {
    const liq = Number(r.liquidity_score);
    if (Number.isFinite(liq) && liq < CONDITIONAL_LIQUIDITY_FLOOR) return false;
  }

  return true;
}

/** Composite ranking score for the high-potential set. Confidence /
 *  final / RR carry the primary weight; factor scores (liquidity,
 *  portfolio_fit, stress_survival, market_regime) contribute a small
 *  boost when present. STALE freshness applies a small penalty so
 *  fresh-but-borderline rows beat older-but-borderline ones. */
export function highPotentialScore(r: TieredRow): number {
  const conf = clampNum(r.confidence_score ?? r.confidence, 0, 100);
  const fin  = clampNum(r.final_score, 0, 100);
  const rr   = clampNum(r.rr_ratio ?? r.risk_reward, 0, 5);

  // Primary score on a 0..100 band.
  let score = conf * 0.45 + fin * 0.35 + (rr / 5) * 100 * 0.20;

  // Optional factor boost — only for factors that are populated.
  const factors = [
    r.liquidity_score,
    r.portfolio_fit_score,
    r.stress_survival_score,
    r.market_regime_score,
  ];
  let factorSum = 0;
  let factorCount = 0;
  for (const f of factors) {
    if (f == null) continue;
    const v = Number(f);
    if (!Number.isFinite(v) || v <= 0) continue;
    factorSum += clampNum(v, 0, 100);
    factorCount++;
  }
  if (factorCount > 0) {
    score += (factorSum / factorCount) * 0.05;
  }

  // Freshness penalty — STALE rows still ship but lose ground to fresh
  // ones in the same band.
  const fresh = String(r.freshness_state ?? '').toUpperCase();
  const decay = String(r.decay_state ?? '').toLowerCase();
  if (fresh === 'STALE')                                   score -= 6;
  if (decay === 'stale' || decay === 'aging')              score -= 6;

  return score;
}

/** Pick the top K rows from a candidate pool that meet the conditional
 *  floors. Returns at most HIGH_POTENTIAL_MAX_ROWS rows, each stamped
 *  `tier='HIGH_POTENTIAL'` and `is_conditional=true`. Empty input or
 *  no eligible rows → empty output. */
export function selectHighPotentialFallback<T extends TieredRow>(
  candidates: readonly T[],
  k: number = HIGH_POTENTIAL_MAX_ROWS,
): T[] {
  if (candidates.length === 0) return [];
  const eligible = candidates.filter(meetsConditionalFloors);
  if (eligible.length === 0) return [];
  const cap = Math.max(1, Math.min(HIGH_POTENTIAL_MAX_ROWS, k));
  // Stable sort by score DESC; tiebreak by confidence DESC then symbol
  // ASC so the same DB state always picks the same rows.
  const ranked = [...eligible].sort((a, b) => {
    const sb = highPotentialScore(b);
    const sa = highPotentialScore(a);
    if (sb !== sa) return sb - sa;
    const ca = Number(a.confidence_score ?? a.confidence ?? 0);
    const cb = Number(b.confidence_score ?? b.confidence ?? 0);
    if (cb !== ca) return cb - ca;
    return String(a.symbol ?? a.tradingsymbol ?? '').localeCompare(
      String(b.symbol ?? b.tradingsymbol ?? ''),
    );
  });
  return ranked.slice(0, cap).map((r) => ({
    ...r,
    tier: 'HIGH_POTENTIAL' as const,
    is_conditional: true,
  })) as T[];
}
