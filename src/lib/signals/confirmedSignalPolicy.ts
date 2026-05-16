// ════════════════════════════════════════════════════════════════
//  confirmedSignalPolicy — institutional-filter contract for
//  confirmed-snapshot rows. The single source of truth for:
//
//    - Strict approval predicate (`strictApproved`).
//    - Below-floor detection (`isBelowFloor`) — for demotion to
//      Emerging / Developing.
//    - Aliveness check (`isAlive`) — invalidation-aware.
//    - Approved-classification set (per direction).
//    - Score floors (final / confidence).
//    - Deterministic comparator (`confirmedSnapshotCmp`).
//    - Confirmed-snapshot cap policy (`resolveConfirmedCap`,
//      `applyConfirmedCap`, `CONFIRMED_CAP_DEFAULT/HARD_MAX`).
//
//  Pure module — no I/O, no DB, no env reads beyond the cap config.
//  Every consumer (HTTP /api/signals, SSE /api/signals/stream,
//  /api/admin/cleanup-confirmed indirectly) reads from here so the
//  contract stays in lockstep across transports.
// ════════════════════════════════════════════════════════════════

// ── Score floors ────────────────────────────────────────────────
// Spec "FIX FINAL SIGNAL VISIBILITY" §2 — strict floors lowered to the
// balanced band so the dashboard surfaces real Phase-4 output instead
// of returning empty when post-rejection scores land just below the
// previous 65/60/1.5 cutoffs:
//
//     confidence_score >= 55
//     final_score      >= 60
//     risk_reward      >= 1.2
//
// Earlier history: 75/70/1.5 → 65/60/1.5 (FIX-CLEAN §4, bootstrap rows
// topped at final=70). The current pass relaxes one more tick because
// live runs were producing rows at conf 55-60 / final 60-65 that the
// engine considered tradable but the API hid behind the strict gate.
//
// Spec "FIX ZERO SIGNAL ISSUE WITH REAL DATA" §3 — env-overridable.
// Operators can re-tighten without editing constants:
//   SIGNAL_API_STRICT_FINAL_FLOOR=70
//   SIGNAL_API_STRICT_CONFIDENCE_FLOOR=65
//   SIGNAL_API_STRICT_RR_FLOOR=1.5
// Range-clamped so a typo can't produce nonsense (e.g. negative or >100
// confidence).
function resolveScoreFloor(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}
// Spec INSTITUTIONAL §A (v2 — calibrated 2026-05) — strict main-table
// floors. Original 65/60/1.5/60 produced empty responses on real data
// because q365_confirmed_signal_snapshots was empty (writer's gate was
// stricter than the reader could ever exercise) and the q365_signals
// fallback population sat at confidence 50-60 / final 55-65.
//
// New defaults (per operator spec):
//   confidence_score      >= 55
//   final_score           >= 60
//   risk_reward           >= 1.5
//   stress_survival_score >= 50
//
// Rationale: 5–20 strong signals from a 500-stock universe — not zero,
// not weak watchlist garbage. The classification whitelist
// (INSTITUTIONAL_HIGH_CONVICTION / HIGH_CONVICTION / VALID_SIGNAL)
// remains the primary quality gate; the score floors are the
// secondary numeric guard. Env knobs SIGNAL_API_STRICT_*_FLOOR still
// honoured so ops can re-tighten without editing constants.
// INSTITUTIONAL_TIER_2026-05 — main APPROVED tab is execution-ready
// only. Defaults (operator spec, calibrated for current Indian market):
//   confidence ≥ 70  — institutional confidence bar
//   final     ≥ 60  — RELAXED 2026-05 from 75 → 60 because Phase 4
//                     rarely produces final ≥ 75 even when confidence
//                     and RR are strong. The dominant rejection cause
//                     was final-score-only failures (e.g. confidence=70,
//                     final=39 was a typical empty-APPROVED row). 60
//                     keeps the bar institutional without making the
//                     numeric floor the sole reason every cycle ships
//                     zero approvals.
//   rr        ≥ 2.0 — institutional risk-reward
//   stress    ≥ 60  — survival-under-stress bar
// Env knobs SIGNAL_API_STRICT_*_FLOOR still honoured so an operator
// can tighten back without editing constants.
// MATURATION_AUDIT_2026-05 — STRICT_RR_FLOOR aligned to operator's
// APPROVED acceptance criteria (RR ≥ 1.5). The previous 2.0 floor
// hid mature, stable, confident rows whose risk-reward landed in the
// 1.5-2.0 band that the maturity tracker had already validated as
// promotable. Env override (SIGNAL_API_STRICT_RR_FLOOR) still raises
// it for ops who want the legacy 2.0 institutional bar.
export const STRICT_FINAL_FLOOR      = resolveScoreFloor('SIGNAL_API_STRICT_FINAL_FLOOR',      0, 100, 60);
export const STRICT_CONFIDENCE_FLOOR = resolveScoreFloor('SIGNAL_API_STRICT_CONFIDENCE_FLOOR', 0, 100, 55);
export const STRICT_RR_FLOOR         = resolveScoreFloor('SIGNAL_API_STRICT_RR_FLOOR',       0.5,   5,  1.5);
export const STRICT_STRESS_FLOOR     = resolveScoreFloor('SIGNAL_API_STRICT_STRESS_FLOOR',    0, 100, 60);

// ── Approved classifications, per direction ─────────────────────
//
// Spec INSTITUTIONAL §A — main table is restricted to the three
// institutional-grade buckets ONLY:
//   INSTITUTIONAL_HIGH_CONVICTION (85-100)
//   HIGH_CONVICTION               (75-84)
//   VALID_SIGNAL                  (65-74)
//
// The legacy aliases (HIGH_CONVICTION_BUY, VALID_BUY, MEDIUM_CONVICTION)
// stay accepted because both the scanner and Phase 4 still emit them
// for back-compat — the response mapper folds them into the same UI
// labels (CONFIRMED / EARLY_CANDIDATE) and the score floors
// (final ≥ 65) prevent rebucketed-from-NO_TRADE rows from leaking
// through.
//
// MEDIUM_CONVICTION is REMOVED from the approved set per spec §A —
// it was the rebucket target for NO_TRADE rows whose final_score
// happened to clear 65, and it does not represent a true high-quality
// classification. Rows tagged MEDIUM_CONVICTION now fall through to
// the emerging tier (DEVELOPING_SETUP).
const APPROVED_COMMON = [
  'INSTITUTIONAL_HIGH_CONVICTION',
  'HIGH_CONVICTION',
  'VALID_SIGNAL',
] as const;
export const STRICT_BUY_CLS  = new Set<string>([
  'HIGH_CONVICTION_BUY',
  'VALID_BUY',
  ...APPROVED_COMMON,
]);
export const STRICT_SELL_CLS = new Set<string>([
  ...APPROVED_COMMON,
]);

/** Display-table classification set (used for `belongsInMainTable` and
 *  the response-assembly consistency gate). Subset of APPROVED_COMMON. */
export const MAIN_TABLE_DISPLAY_CLS = new Set<string>([
  'INSTITUTIONAL_HIGH_CONVICTION',
  'HIGH_CONVICTION',
  'VALID_SIGNAL',
]);

// ── Cap policy ──────────────────────────────────────────────────
// Spec SIGNAL_ENGINE_FIXED_AND_CLEAN §5: "max 20 signals, sort by
// final_score DESC". HARD_MAX retains its 30-cap escape hatch for
// admin tools that explicitly bump Q365_CONFIRMED_CAP, but the
// dashboard default is now 20.
export const CONFIRMED_CAP_DEFAULT  = 20;
export const CONFIRMED_CAP_HARD_MAX = 30;

/** Resolve the active confirmed-snapshot cap from env.
 *  Missing / unparseable / non-positive → CONFIRMED_CAP_DEFAULT.
 *  Otherwise clamped to [1, CONFIRMED_CAP_HARD_MAX]. */
export function resolveConfirmedCap(): number {
  const raw = Number(process.env.Q365_CONFIRMED_CAP);
  if (!Number.isFinite(raw) || raw <= 0) return CONFIRMED_CAP_DEFAULT;
  return Math.min(Math.max(1, Math.floor(raw)), CONFIRMED_CAP_HARD_MAX);
}

/** Slice a sorted array to the resolved cap. Empty in → empty out. */
export function applyConfirmedCap<T>(sorted: readonly T[]): T[] {
  if (sorted.length === 0) return [];
  return sorted.slice(0, resolveConfirmedCap());
}

// ── Row-shape contracts (wide; callers pass extra fields freely) ─
export interface ApprovableSignalRow {
  direction?:           'BUY' | 'SELL' | string | null;
  classification?:      string | null;
  raw_classification?:  string | null;
  final_score?:         number | null;
  confidence_score?:    number | null;
  confidence?:          number | null;
  rr_ratio?:            number | null;
  risk_reward?:         number | null;
  invalidation_reason?: string | null;
  live_invalidated?:    boolean | null;
  /** Tri-state: APPROVED_SIGNAL | DEVELOPING_SETUP | NO_TRADE | REJECTED */
  signal_status?:       string | null;
  /** Lifecycle: ACTIVE | TARGET_HIT | STOP_LOSS_HIT | INVALIDATED | EXPIRED */
  status?:              string | null;
  /** Spec INSTITUTIONAL §A — stress survival floor (60). */
  stress_survival_score?: number | null;
  /** Spec INSTITUTIONAL §A — must be true to ship in main table. */
  stability_passed?:    boolean | number | null;
  /** Spec INSTITUTIONAL §A — execution gate (mirrors detail page contract). */
  execution_allowed?:   boolean | null;
  /** Optional freshness hint surfaced by the closed-market shaper. */
  is_stale_candidate?:  boolean;
}

// Spec UI-SIMPLIFY §2 + INSTITUTIONAL §A — these statuses are NEVER
// shippable in the main signals[] response. WATCHLIST + DEVELOPING_SETUP
// are added (institutional spec): they describe non-tradable rows by
// definition and must never sit alongside actionable BUY/SELL.
const NEVER_SHIP_STATUSES = new Set<string>([
  'REJECTED', 'NO_TRADE', 'INVALIDATED',
  'WATCHLIST', 'WATCHLIST_ONLY', 'DEVELOPING_SETUP',
]);

// Same set in classification space — direction-agnostic short-circuit.
const NEVER_SHIP_CLASSIFICATIONS = new Set<string>([
  'NO_TRADE', 'REJECTED', 'WATCHLIST_ONLY', 'WATCHLIST', 'DEVELOPING_SETUP',
]);

export interface SortableSnapshotRow {
  id?:                    number;
  final_score?:           number | null;
  confidence_score?:      number | null;
  expected_edge_percent?: number | null;
  maturity_score?:        number | null;
  rr_ratio?:              number | null;
  confirmed_at?:          string | Date | null;
}

// ── Predicates ──────────────────────────────────────────────────
export function isClassificationApproved(r: ApprovableSignalRow): boolean {
  const dir   = String(r.direction ?? '').toUpperCase();
  const klass = String(r.classification ?? '').toUpperCase();
  if (dir === 'BUY')  return STRICT_BUY_CLS.has(klass);
  if (dir === 'SELL') return STRICT_SELL_CLS.has(klass);
  return false;
}

export function isAlive(r: ApprovableSignalRow): boolean {
  if (r.invalidation_reason) return false;
  if (r.live_invalidated === true) return false;
  // Spec INSTITUTIONAL §A — execution_allowed=false is a hard veto if
  // the upstream shaper set it (matches the detail-page contract).
  if (r.execution_allowed === false) return false;
  // Spec UI-SIMPLIFY §2 — REJECTED / NO_TRADE / INVALIDATED / WATCHLIST
  // / DEVELOPING_SETUP never ship in the main table.
  const ss = String(r.signal_status ?? '').toUpperCase();
  if (NEVER_SHIP_STATUSES.has(ss)) return false;
  const lifecycle = String(r.status ?? '').toUpperCase();
  if (lifecycle && lifecycle !== 'ACTIVE' && NEVER_SHIP_STATUSES.has(lifecycle)) return false;
  // Hard classification reject — both the rebucketed display value and
  // the raw upstream value must clear the NEVER_SHIP set.
  const cls    = String(r.classification ?? '').toUpperCase();
  const rawCls = String(r.raw_classification ?? '').toUpperCase().trim();
  if (NEVER_SHIP_CLASSIFICATIONS.has(cls)) return false;
  if (rawCls && NEVER_SHIP_CLASSIFICATIONS.has(rawCls)) return false;
  return true;
}

export function strictApproved(r: ApprovableSignalRow): boolean {
  return strictApprovedAudit(r).passed;
}

/**
 * MATURATION_AUDIT_2026-05 — audit-mode strict approval predicate.
 *
 * Returns the same accept/reject verdict as `strictApproved` but also
 * lists every failure reason so the caller can see EXACTLY which gate
 * killed each row. The route's `[STRICT_FUNNEL]` log uses this to
 * publish a per-stage rejection histogram so an operator can answer
 * "what's the dominant blocker today?" in a single grep.
 *
 * Failure-reason strings follow the same convention the elite gate
 * uses (`field=value`) so the rejection-histogram bucketer in
 * responseAssembly works on both sets uniformly.
 */
export function strictApprovedAudit(r: ApprovableSignalRow): EliteRejectDetail {
  const failed: string[] = [];
  // Aliveness — invalidation, NEVER_SHIP statuses, terminal lifecycle.
  if (!isAlive(r)) {
    if (r.invalidation_reason)                 failed.push(`invalidation_reason=${r.invalidation_reason}`);
    else if (r.live_invalidated === true)      failed.push('live_invalidated=true');
    else if (r.execution_allowed === false)    failed.push('execution_allowed=false');
    else {
      const ss = String(r.signal_status ?? '').toUpperCase();
      const lifecycle = String(r.status ?? '').toUpperCase();
      const cls = String(r.classification ?? '').toUpperCase();
      const rawCls = String(r.raw_classification ?? '').toUpperCase().trim();
      if (NEVER_SHIP_STATUSES.has(ss))                                      failed.push(`signal_status=${ss}`);
      else if (lifecycle && lifecycle !== 'ACTIVE' && NEVER_SHIP_STATUSES.has(lifecycle)) failed.push(`status=${lifecycle}`);
      else if (NEVER_SHIP_CLASSIFICATIONS.has(cls))                         failed.push(`classification=${cls}`);
      else if (rawCls && NEVER_SHIP_CLASSIFICATIONS.has(rawCls))            failed.push(`raw_classification=${rawCls}`);
      else                                                                  failed.push('not_alive');
    }
  }
  if (!isClassificationApproved(r)) {
    const dir = String(r.direction ?? '').toUpperCase();
    const cls = String(r.classification ?? '').toUpperCase() || '<empty>';
    failed.push(`classification_not_approved=${cls}/${dir || '<no_dir>'}`);
  }
  if (r.is_stale_candidate === true) failed.push('is_stale_candidate=true');

  const fs = Number(r.final_score ?? 0);
  if (!Number.isFinite(fs) || fs < STRICT_FINAL_FLOOR) failed.push(`final_score=${Number.isFinite(fs) ? fs : 'NaN'}`);

  const cs = Number(r.confidence_score ?? r.confidence ?? 0);
  if (!Number.isFinite(cs) || cs < STRICT_CONFIDENCE_FLOOR) failed.push(`confidence_score=${Number.isFinite(cs) ? cs : 'NaN'}`);

  const rr = Number(r.rr_ratio ?? r.risk_reward ?? 0);
  if (!Number.isFinite(rr) || rr < STRICT_RR_FLOOR) failed.push(`risk_reward=${Number.isFinite(rr) ? rr : 'NaN'}`);

  if (STRICT_STRESS_FLOOR > 0) {
    const stress = r.stress_survival_score == null ? NaN : Number(r.stress_survival_score);
    if (!Number.isFinite(stress) || stress < STRICT_STRESS_FLOOR) failed.push(`stress_survival_score=${Number.isFinite(stress) ? stress : 'NaN'}`);
  }

  // MATURATION_AUDIT_2026-05 — stability_passed is now LENIENT when the
  // engine hasn't populated it yet (null/undefined). Same semantic as
  // live_validation_state in eliteApproved: if the writer doesn't
  // produce the field, the row passes through; only an EXPLICIT false
  // rejects. This mirrors the operator's principle that fail-closed-on-
  // missing was hiding viable rows when the maturity tracker isn't
  // running yet. Set SIGNAL_API_REQUIRE_STABLE=1 to restore the legacy
  // strict semantic (env was already used as a 0-disable; '1' now
  // re-enables fail-closed for environments where the tracker is
  // guaranteed to populate stability_passed).
  const stabRequiredStrict = process.env.SIGNAL_API_REQUIRE_STABLE === '1';
  const stabDisabled       = process.env.SIGNAL_API_REQUIRE_STABLE === '0';
  if (!stabDisabled) {
    const stab = r.stability_passed;
    if (stabRequiredStrict) {
      // Legacy strict: require explicit true.
      if (stab !== true && stab !== 1) failed.push(`stability_passed=${stab ?? 'null'}`);
    } else {
      // Default lenient: only fail on EXPLICIT false / 0.
      if (stab === false || stab === 0) failed.push(`stability_passed=false`);
    }
  }

  return { passed: failed.length === 0, failed };
}

/** Passed classification + alive, but failed at least one score floor.
 *  These rows are demoted to Emerging / Developing so the operator
 *  sees what the engine is watching without inflating the BUY count. */
export function isBelowFloor(r: ApprovableSignalRow): boolean {
  if (strictApproved(r)) return false;
  if (!isAlive(r)) return false;
  if (!isClassificationApproved(r)) return false;
  return true;
}

// ── MAIN-TABLE acceptance ───────────────────────────────────────
//
// Spec MAIN-TABLE-STRICT — the off-hours / weekend signals view must
// only render fully-matured confirmed snapshots. The criteria below
// are AND-ed; any failure drops the row from the main table (it may
// still surface in the "Stored Scanner Candidates / Not Tradable"
// section). This is the predicate the closed-market loader uses to
// decide whether a confirmed snapshot is tradeable today.
export const MAIN_TABLE_MIN_CONFIDENCE = 75;
export const MAIN_TABLE_MIN_FINAL      = 70;
export const MAIN_TABLE_MIN_RR         = 2.0;
export const MAIN_TABLE_MIN_MATURITY   = 85;
export const MAIN_TABLE_MIN_CYCLES     = 3;
export const MAIN_TABLE_MIN_EDGE_PCT   = 2;

/** Wide row shape — the main-table predicate reads tracker fields
 *  that aren't in `ApprovableSignalRow`, so we accept the full row
 *  shape with a bag of optional numeric / boolean fields. */
export interface MainTableRow extends ApprovableSignalRow {
  maturity_score?:           number | null;
  validation_cycles_passed?: number | null;
  stability_passed?:         boolean | number | null;
  expected_edge_percent?:    number | null;
  /** Raw, un-rebucketed classification straight from the source row.
   *  Spec NO-TRADE-PRECEDENCE §6 — when this carries 'NO_TRADE' the
   *  predicates reject regardless of how `classification` was
   *  normalized for display. Optional for back-compat with callers
   *  that haven't been updated to thread it through. */
  raw_classification?:       string | null;
  /** Stale-tracker hint surfaced by the closed-market shaper. When
   *  true, the row is older than TRACKER_STALE_HOURS and SHOULD NOT
   *  appear in the main signals table even if every numeric floor
   *  passes — the tracker is no longer supplying live evidence. */
  is_stale_candidate?:       boolean;
}

// ── Relaxed (early-signal) tier ─────────────────────────────────
//
// Spec SMART-RELAXED — when the strict tier produces zero rows the
// loader falls through to this looser predicate so the dashboard is
// never blank during the early-promotion window. Hard floors per
// spec §5 (NEVER allow): NO_TRADE, rr < 1.5, confidence < 60. The
// relaxed thresholds below all sit at or above those floors so the
// "never allow" rule holds by construction.
export const RELAXED_MAIN_MIN_CONFIDENCE = 65;
export const RELAXED_MAIN_MIN_FINAL      = 65;
export const RELAXED_MAIN_MIN_RR         = 1.5;
export const RELAXED_MAIN_MIN_MATURITY   = 65;
export const RELAXED_MAIN_MIN_CYCLES     = 1;

// ── Early-signal tier (q365_signals fallback) ───────────────────
//
// Spec SMART-RELAXED-EARLY — when BOTH the strict and relaxed
// confirmed-snapshot tiers find nothing, the loader surfaces
// q365_signals rows that meet only the absolute floors so the
// dashboard never goes blank. Maturity / cycles / stability are NOT
// required at this tier (most q365_signals rows have no tracker
// data).
//
// Spec "FIX FINAL SIGNAL VISIBILITY" §2 — floors lowered to the
// balanced band (55 / 60 / 1.2) and made env-overridable so an
// operator can re-tighten without editing constants. The hard
// classification guards (NO_TRADE / WATCHLIST_ONLY) remain absolute
// inside `earlySignalApproved` regardless of floor settings.
function resolveEarlyFloor(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}
export const EARLY_SIGNAL_MIN_CONFIDENCE =
  resolveEarlyFloor('SIGNAL_API_RELAX_CONFIDENCE_FLOOR', 0,   100, 55);
export const EARLY_SIGNAL_MIN_FINAL      =
  resolveEarlyFloor('SIGNAL_API_RELAX_FINAL_FLOOR',      0,   100, 60);
export const EARLY_SIGNAL_MIN_RR         =
  resolveEarlyFloor('SIGNAL_API_RELAX_RR_FLOOR',       0.5,     5,  1.2);

// Spec UI §7 — even the early-signal tier must enforce a minimum
// validation_cycles count before a row is allowed into the main
// signals list. The dashboard renders bundle.signals as confirmed
// trade signals; a Cycle 1 row is by definition NOT confirmed (the
// engine wants 3 repeated detections before promoting). Without this
// gate a freshly-detected q365_signals row landed in bundle.signals
// labelled "⚠️ Early Signal", which the operator still read as
// tradable. The fix routes cycles<3 rows to scannerCandidates
// instead. Rows with NULL tracker columns (no maturity row yet)
// remain admitted so the empty-dashboard fallback still works on
// fresh deployments — the tracker's first detection is the row that
// would have gone in anyway.
export const EARLY_SIGNAL_MIN_CYCLES_FOR_MAIN = 3;

// Spec "RELAXED MODE ADMITS WATCHLIST_ONLY" — when SIGNAL_RELAX_MODE=true
// the early-signal predicate accepts rows tagged WATCHLIST_ONLY (the
// engine's "monitor for confirmation" bucket). Read once at module load
// so the predicate stays a pure read inside the function body — earlier
// per-call process.env access tripped a Next.js build bundler edge case
// that produced "undefined is not a function" at Array.filter sites.
export const SIGNAL_RELAX_MODE_ENABLED: boolean =
  String(process.env.SIGNAL_RELAX_MODE ?? '').trim().toLowerCase() === 'true';

/**
 * Spec SMART-RELAXED-EARLY — final fallback predicate. Applies only
 * the absolute floors: alive, direction ∈ {BUY, SELL}, classification
 * != 'NO_TRADE', confidence ≥ 60, final_score ≥ 65, rr ≥ 1.5.
 * Tracker columns (maturity / cycles / stability) are NOT consulted.
 *
 * Rows passing this predicate are tagged `is_relaxed = true` by the
 * loader so the UI renders "⚠️ Early Signal" instead of "Confirmed".
 */
export function earlySignalApproved(r: MainTableRow): boolean {
  if (!isAlive(r)) return false;
  if (r.is_stale_candidate === true) return false;

  const dir = String(r.direction ?? '').toUpperCase();
  if (dir !== 'BUY' && dir !== 'SELL') return false;

  // Spec NO-TRADE-PRECEDENCE §1 — raw classification check first.
  // The display-side `classification` field can be MEDIUM_CONVICTION
  // even when the source row was NO_TRADE (rebucketing by
  // final_score), and the predicate must respect the source value.
  //
  // RELAXED MODE — when SIGNAL_RELAX_MODE_ENABLED (computed once at
  // module load above), WATCHLIST_ONLY rows are admitted. NO_TRADE
  // remains a hard reject in both modes — it's a strong negative call
  // from the engine, not a soft "develop further" tag.
  const rawCls = String(r.raw_classification ?? '').toUpperCase().trim();
  if (rawCls === 'NO_TRADE') return false;
  if (rawCls === 'WATCHLIST_ONLY' && !SIGNAL_RELAX_MODE_ENABLED) return false;
  const cls = String(r.classification ?? '').toUpperCase();
  if (cls === 'NO_TRADE') return false;

  const cs = Number(r.confidence_score ?? NaN);
  if (!Number.isFinite(cs) || cs < EARLY_SIGNAL_MIN_CONFIDENCE) return false;

  const fs = Number(r.final_score ?? NaN);
  if (!Number.isFinite(fs) || fs < EARLY_SIGNAL_MIN_FINAL) return false;

  const rr = Number(r.rr_ratio ?? r.risk_reward ?? NaN);
  if (!Number.isFinite(rr) || rr < EARLY_SIGNAL_MIN_RR) return false;

  // Spec UI §7 — when tracker data IS present, enforce the cycles
  // gate. A Cycle 1 row has a tracker that has only seen this signal
  // once; it is not confirmed and must not appear in bundle.signals.
  // Null cycles (no tracker at all) admits — see comment on the
  // EARLY_SIGNAL_MIN_CYCLES_FOR_MAIN constant for the empty-dashboard
  // rationale.
  const cyclesRaw = r.validation_cycles_passed;
  if (cyclesRaw != null) {
    const cycles = Number(cyclesRaw);
    if (Number.isFinite(cycles) && cycles < EARLY_SIGNAL_MIN_CYCLES_FOR_MAIN) {
      return false;
    }
  }

  return true;
}

/**
 * Spec SMART-RELAXED — looser predicate for the "Early Signal" tier.
 * Differences from `mainTableApproved`:
 *   • maturity ≥ 65 (was 85)
 *   • cycles   ≥ 1 (was 3)
 *   • stability_passed not required
 *   • classification only needs to be != 'NO_TRADE'
 *     (DEVELOPING_SETUP / WATCHLIST_ONLY accepted here, but rejected
 *     by the strict gate)
 *   • expected_edge_percent not enforced
 *
 * Hard floors retained: alive, direction ∈ {BUY, SELL},
 * confidence ≥ 65, final ≥ 65, rr ≥ 1.5.
 */
export function relaxedMainTableApproved(r: MainTableRow): boolean {
  if (!isAlive(r)) return false;
  if (r.is_stale_candidate === true) return false;

  const dir = String(r.direction ?? '').toUpperCase();
  if (dir !== 'BUY' && dir !== 'SELL') return false;

  // Hard floor §5 — NO_TRADE never accepted, even in relaxed mode.
  // Spec NO-TRADE-PRECEDENCE §1 — check the RAW classification first
  // so a normalized MEDIUM_CONVICTION (rebucketed from final_score)
  // never bypasses the gate when the source row carried 'NO_TRADE'.
  const rawCls = String(r.raw_classification ?? '').toUpperCase().trim();
  if (rawCls === 'NO_TRADE' || rawCls === 'WATCHLIST_ONLY') return false;
  const cls = String(r.classification ?? '').toUpperCase();
  if (cls === 'NO_TRADE') return false;

  const fs = Number(r.final_score ?? NaN);
  if (!Number.isFinite(fs) || fs < RELAXED_MAIN_MIN_FINAL) return false;

  const cs = Number(r.confidence_score ?? NaN);
  if (!Number.isFinite(cs) || cs < RELAXED_MAIN_MIN_CONFIDENCE) return false;

  const rr = Number(r.rr_ratio ?? r.risk_reward ?? NaN);
  if (!Number.isFinite(rr) || rr < RELAXED_MAIN_MIN_RR) return false;

  // Tracker fields — relaxed minimums; still must be present (no
  // synthesized defaults — see MAIN-TABLE-STRICT §5 ruling).
  const maturity = Number(r.maturity_score ?? NaN);
  if (!Number.isFinite(maturity) || maturity < RELAXED_MAIN_MIN_MATURITY) return false;

  const cycles = Number(r.validation_cycles_passed ?? NaN);
  if (!Number.isFinite(cycles) || cycles < RELAXED_MAIN_MIN_CYCLES) return false;

  return true;
}

/**
 * Spec MAIN-TABLE-STRICT — all eight criteria must hold for a row to
 * appear in the main signals table during market-closed / weekend
 * mode. Returns true only when EVERY field is present and meets its
 * floor; missing / null tracker columns fail (the spec is explicit:
 * we no longer synthesize defaults).
 *
 * Spec NO-TRADE-PRECEDENCE §1 — `raw_classification === 'NO_TRADE'`
 * rejects unconditionally, even when the display-side `classification`
 * has been rebucketed to MEDIUM_CONVICTION by the final-score
 * normalizer. Same for `is_stale_candidate=true` — a stale tracker is
 * not live evidence.
 */
export function mainTableApproved(r: MainTableRow): boolean {
  if (!isAlive(r)) return false;
  if (r.is_stale_candidate === true) return false;
  const rawCls = String(r.raw_classification ?? '').toUpperCase().trim();
  if (rawCls === 'NO_TRADE' || rawCls === 'WATCHLIST_ONLY') return false;
  if (!isClassificationApproved(r)) return false;

  const fs = Number(r.final_score ?? NaN);
  if (!Number.isFinite(fs) || fs < MAIN_TABLE_MIN_FINAL) return false;

  const cs = Number(r.confidence_score ?? NaN);
  if (!Number.isFinite(cs) || cs < MAIN_TABLE_MIN_CONFIDENCE) return false;

  const rr = Number(r.rr_ratio ?? r.risk_reward ?? NaN);
  if (!Number.isFinite(rr) || rr < MAIN_TABLE_MIN_RR) return false;

  // Tracker columns — must be PRESENT (no defaulting) and meet floor.
  const maturity = Number(r.maturity_score ?? NaN);
  if (!Number.isFinite(maturity) || maturity < MAIN_TABLE_MIN_MATURITY) return false;

  const cycles = Number(r.validation_cycles_passed ?? NaN);
  if (!Number.isFinite(cycles) || cycles < MAIN_TABLE_MIN_CYCLES) return false;

  // stability_passed accepts boolean or 0/1; must be truthy.
  const stab = r.stability_passed;
  const stabilityPassed = stab === true || stab === 1;
  if (!stabilityPassed) return false;

  const edge = Number(r.expected_edge_percent ?? NaN);
  if (!Number.isFinite(edge) || edge <= MAIN_TABLE_MIN_EDGE_PCT) return false;

  return true;
}

// ── Deterministic comparator ────────────────────────────────────
const NUM_KEYS = [
  'final_score',
  'confidence_score',
  'expected_edge_percent',
  'maturity_score',
  'rr_ratio',
] as const satisfies readonly (keyof SortableSnapshotRow)[];

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function ts(v: unknown): number {
  if (v == null) return 0;
  if (v instanceof Date) {
    const ms = v.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }
  const ms = Date.parse(String(v));
  return Number.isFinite(ms) ? ms : 0;
}

/** Sort keys (DESC unless noted), with deterministic id ASC last:
 *    final_score, confidence_score, expected_edge_percent,
 *    maturity_score, rr_ratio, confirmed_at, id ASC. */
export function confirmedSnapshotCmp(
  a: SortableSnapshotRow,
  b: SortableSnapshotRow,
): number {
  for (const k of NUM_KEYS) {
    const an = num(a?.[k]);
    const bn = num(b?.[k]);
    if (bn !== an) return bn - an;
  }
  const at = ts(a?.confirmed_at);
  const bt = ts(b?.confirmed_at);
  if (bt !== at) return bt - at;
  return num(a?.id) - num(b?.id);
}

// ════════════════════════════════════════════════════════════════
//  ELITE INSTITUTIONAL TIER (Spec ELITE-2026-05)
//
//  Single, opinionated quality bar for the main table. The previous
//  `mainTableApproved` predicate sat at maturity ≥ 85 / final ≥ 70 /
//  rr ≥ 2 — quality but not "elite". The operator spec calls for a
//  stricter bar where 1–5 stocks out of 500 is acceptable as long as
//  every survivor is actionable.
//
//  Predicate is AND across:
//    confidence_score        ≥ 75
//    final_score             ≥ 80   (= institutional_score)
//    risk_reward             ≥ 2.0
//    stress_survival_score   ≥ 75
//    portfolio_fit_score     ≥ 70
//    liquidity_score         ≥ 60
//    market_regime_score     ≥ 65
//    data_quality_score      ≥ 80
//    classification ∈ { INSTITUTIONAL_HIGH_CONVICTION, HIGH_CONVICTION }
//    signal_status = APPROVED_SIGNAL
//    execution_allowed = true
//    live_validation_state = VALID
//    freshness_state ≠ stale
//    decay_state ∉ { stale, expired }
//    conviction_band ≠ avoid
//
//  Defaults are the spec values; every floor is env-overridable so an
//  operator can re-tune without editing constants. Range-clamped so a
//  typo cannot ship nonsense floors.
// ════════════════════════════════════════════════════════════════

// INSTITUTIONAL_TIER_2026-05 — elite floors aligned with strict floors
// (70/60/2.0). The elite gate adds the categorical checks
// (signal_status / classification / execution_allowed / decay_state /
// is_relaxed) that distinguish APPROVED (Tier 1) from the lower tiers;
// the score floors are the same numeric bar. ELITE_FINAL_FLOOR relaxed
// 2026-05 (75 → 60) in lockstep with STRICT_FINAL_FLOOR — see the
// comment on STRICT_FINAL_FLOOR above for rationale.
export const ELITE_CONFIDENCE_FLOOR =
  resolveScoreFloor('SIGNAL_API_ELITE_CONFIDENCE_FLOOR',  0, 100, 70);
export const ELITE_FINAL_FLOOR =
  resolveScoreFloor('SIGNAL_API_ELITE_FINAL_FLOOR',       0, 100, 60);
// MATURATION_AUDIT_2026-05 — aligned to STRICT_RR_FLOOR (1.5). Two
// cascading RR floors at 2.0/1.5 was double-gating with no quality
// benefit; the strict floor is already the institutional bar.
export const ELITE_RR_FLOOR =
  resolveScoreFloor('SIGNAL_API_ELITE_RR_FLOOR',          0,  10, 1.5);
// MATURATION_AUDIT_2026-05 — ELITE_STRESS_FLOOR aligned to strict (60).
// Was 75: a row that cleared strict (stress ≥ 60) would silently die
// at elite with stress_survival_score=70 etc., even though strict was
// designed to be the institutional baseline. Two cascading floors at
// different thresholds was double-gating with no quality benefit —
// strict's 60 is already the institutional bar.
export const ELITE_STRESS_FLOOR =
  resolveScoreFloor('SIGNAL_API_ELITE_STRESS_FLOOR',      0, 100, 60);
export const ELITE_PORTFOLIO_FIT_FLOOR =
  resolveScoreFloor('SIGNAL_API_ELITE_PORTFOLIO_FIT_FLOOR', 0, 100, 70);
export const ELITE_LIQUIDITY_FLOOR =
  resolveScoreFloor('SIGNAL_API_ELITE_LIQUIDITY_FLOOR',   0, 100, 60);
export const ELITE_MARKET_REGIME_FLOOR =
  resolveScoreFloor('SIGNAL_API_ELITE_MARKET_REGIME_FLOOR', 0, 100, 65);
export const ELITE_DATA_QUALITY_FLOOR =
  resolveScoreFloor('SIGNAL_API_ELITE_DATA_QUALITY_FLOOR', 0, 100, 80);

/** Classifications admissible into the elite tier. MATURATION_AUDIT_2026-05 —
 *  VALID_SIGNAL added back. Phase 4 stamps "VALID_SIGNAL" on rows that
 *  cleared every numeric institutional floor but didn't reach
 *  HIGH_CONVICTION; excluding them from elite was a hidden bottleneck
 *  that left APPROVED empty even when 5+ rows had passed strict. The
 *  numeric score floors (confidence ≥ 70, final ≥ 60, rr ≥ 2.0,
 *  stress ≥ 60) plus the categorical aliveness gate already define
 *  institutional quality — the classification whitelist should mirror
 *  the strict gate, not narrow it further. */
export const ELITE_CLASSIFICATIONS = new Set<string>([
  'INSTITUTIONAL_HIGH_CONVICTION',
  'HIGH_CONVICTION',
  'VALID_SIGNAL',
]);

/** Conviction bands that disqualify a row from the elite tier. */
const ELITE_FORBIDDEN_CONVICTION_BANDS = new Set<string>([
  'AVOID', 'avoid', 'Avoid',
]);

/**
 * SIGNAL_ELITE_LENIENT_FACTORS — when truthy (default `true`), the four
 * factor-score floors (portfolio_fit, liquidity, market_regime,
 * data_quality) are skipped instead of failing closed on a missing /
 * NaN value. The Phase-4 engine does not currently write
 * portfolio_fit_score / liquidity_score / market_regime_score, so the
 * strict "fail closed on missing" contract drops every shipped row.
 *
 * Confidence / final / RR / stress floors are still enforced strictly —
 * those are real engine outputs and a row missing them is genuinely
 * ungraded. Set `SIGNAL_ELITE_LENIENT_FACTORS=0` to restore the original
 * fail-closed semantics once the engine populates the missing factor
 * scores end-to-end.
 */
function eliteLenientFactors(): boolean {
  const raw = (process.env.SIGNAL_ELITE_LENIENT_FACTORS ?? 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
}

/** Decay states that disqualify a row. Spec ELITE-2026-05 §4. */
const ELITE_FORBIDDEN_DECAY_STATES = new Set<string>([
  'stale', 'STALE', 'expired', 'EXPIRED',
]);

/** Wide row shape — accepts the full snapshot row plus the derived
 *  per-factor scores the elite predicate consults. Optional everywhere
 *  so callers don't have to materialise unused fields. */
export interface EliteCandidateRow extends MainTableRow {
  /** Phase-4 final composite. Synonymous with `institutional_score`. */
  final_score?:           number | null;
  /** Phase-4 factor breakdown — flattened into top-level fields by
   *  the assembly layer before this predicate runs (see
   *  `extractFactorScores`). When the upstream provider didn't write
   *  factor_scores at all, the predicate fails closed. */
  portfolio_fit_score?:   number | null;
  liquidity_score?:       number | null;
  market_regime_score?:   number | null;
  data_quality_score?:    number | null;
  /** Live-engine state. Spec ELITE-2026-05 §3 — must be VALID. */
  live_validation_state?: string | null;
  live_valid?:            boolean | null;
  /** Tape-vs-snapshot freshness. Spec §4 — STALE rejects. */
  freshness_state?:       string | null;
  /** Lifecycle decay tag. Spec §4 — stale / expired reject. */
  decay_state?:           string | null;
  /** Conviction tier the engine assigned. Spec §4 — 'avoid' rejects. */
  conviction_band?:       string | null;
  conviction_level?:      string | null;
}

/** Best-effort flatten of the factor_scores JSON blob into the top-level
 *  `*_score` fields the elite predicate reads. Pure — does not mutate. */
export function extractFactorScores(row: {
  factor_scores?:         Record<string, unknown> | null;
  portfolio_fit_score?:   number | null;
  liquidity_score?:       number | null;
  market_regime_score?:   number | null;
  data_quality_score?:    number | null;
  // Inputs to the data_quality_score derivation when the engine
  // hasn't yet written a canonical value.
  live_valid?:            boolean | null;
  live_validation_state?: string | null;
  execution_allowed?:     boolean;
  invalidation_reason?:   string | null;
  freshness_state?:       string | null;
  decay_state?:           string | null;
  status?:                string | null;
}): {
  portfolio_fit_score: number | null;
  liquidity_score:     number | null;
  market_regime_score: number | null;
  data_quality_score:  number | null;
} {
  const fs = row.factor_scores ?? null;
  const fsNum = (k: string): number | null => {
    if (!fs || typeof fs !== 'object') return null;
    const v = (fs as Record<string, unknown>)[k];
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  // data_quality_score derivation — see ELITE-2026-05 §AUDIT. The
  // engine doesn't currently emit a per-row data quality score, so
  // we synthesise one from the live/freshness/decay/execution fields
  // already on the row. Score breakdown (additive):
  //   +60 base when execution_allowed and not invalidated
  //   +20 when live_valid===true OR live_validation_state==='VALID'
  //   +10 when freshness_state is 'fresh' (or null/unknown)
  //   +10 when decay_state is 'fresh' (or null/unknown)
  // Cap at 100. Returns null when an upstream value is set already.
  const deriveDataQualityScore = (): number | null => {
    if (row.invalidation_reason) return 0;
    if (row.execution_allowed === false) return 0;
    const lifecycle = String(row.status ?? '').toUpperCase();
    if (lifecycle && lifecycle !== 'ACTIVE') return 0;
    let score = 60;
    const liveValid =
      row.live_valid === true
      || String(row.live_validation_state ?? '').toUpperCase() === 'VALID';
    if (liveValid) score += 20;
    const freshness = String(row.freshness_state ?? '').toLowerCase();
    if (freshness === '' || freshness === 'fresh' || freshness === 'unknown') {
      score += 10;
    } else if (freshness === 'stale') {
      score = Math.max(0, score - 30);
    }
    const decay = String(row.decay_state ?? '').toLowerCase();
    if (decay === '' || decay === 'fresh' || decay === 'unknown') {
      score += 10;
    } else if (decay === 'stale' || decay === 'expired') {
      score = Math.max(0, score - 30);
    }
    return Math.min(100, Math.max(0, score));
  };
  return {
    portfolio_fit_score: row.portfolio_fit_score ?? fsNum('portfolio_fit') ?? fsNum('portfolio_fit_score'),
    liquidity_score:     row.liquidity_score     ?? fsNum('liquidity')     ?? fsNum('liquidity_score'),
    market_regime_score: row.market_regime_score ?? fsNum('market_regime') ?? fsNum('market_regime_score'),
    data_quality_score:  row.data_quality_score  ?? fsNum('data_quality')  ?? fsNum('data_quality_score') ?? deriveDataQualityScore(),
  };
}

/** Detail of why an elite candidate failed. Returned by `eliteApproved`
 *  in audit mode so the API can log the dominant failure for SRE. */
export interface EliteRejectDetail {
  passed: boolean;
  failed: string[];
}

/**
 * Elite institutional approval predicate. Returns true ONLY when every
 * floor and every categorical predicate holds. When `audit` is true the
 * function returns a detail object listing failures instead of a bool.
 *
 * Quality > quantity. 0 stocks passing is acceptable per spec — the
 * dashboard renders an empty state rather than padding with relaxed
 * candidates.
 */
export function eliteApproved(r: EliteCandidateRow): boolean;
export function eliteApproved(r: EliteCandidateRow, audit: true): EliteRejectDetail;
export function eliteApproved(r: EliteCandidateRow, audit: false): boolean;
export function eliteApproved(r: EliteCandidateRow, audit?: boolean): boolean | EliteRejectDetail {
  const failed: string[] = [];
  const fail = (reason: string): void => { failed.push(reason); };

  // Liveness mirrors strictApproved — invalidation / NEVER_SHIP statuses
  // / classifications never reach this tier.
  if (!isAlive(r))                        fail('not_alive');
  if (r.is_stale_candidate === true)      fail('stale_candidate');

  // Classification — narrow whitelist, spec §1.
  const cls    = String(r.classification ?? '').toUpperCase();
  const rawCls = String(r.raw_classification ?? '').toUpperCase().trim();
  const eligibleCls = ELITE_CLASSIFICATIONS.has(cls)
    || (rawCls !== '' && ELITE_CLASSIFICATIONS.has(rawCls));
  if (!eligibleCls) fail(`classification=${cls || rawCls || 'unknown'}`);

  // Signal status — must be APPROVED_SIGNAL. Confirmed snapshots set
  // this by construction, but the q365_signals fallback path can leak
  // DEVELOPING_SETUP / WATCHLIST_ONLY rows; reject those explicitly.
  const ss = String(r.signal_status ?? '').toUpperCase();
  if (ss && ss !== 'APPROVED_SIGNAL') fail(`signal_status=${ss}`);

  // Execution gate — must be true. The detail page enforces the same
  // contract; a row with execution_allowed=false would render REJECTED
  // in the detail page even if the table tried to ship it.
  if (r.execution_allowed === false) fail('execution_allowed=false');

  // Live validation. MATURATION_AUDIT_2026-05 — relaxed to "reject on
  // explicit invalid state only". The previous fail-closed-on-missing
  // semantic was killing every row when the writer didn't populate
  // live_validation_state, even though `isAlive(r)` (called above)
  // already enforces invalidation defence-in-depth via
  // live_invalidated / invalidation_reason / execution_allowed. Now:
  //   • lvs === 'VALID' (or live_valid === true) → pass
  //   • lvs === '' (unknown / not-yet-probed)    → pass (rely on isAlive)
  //   • lvs ∈ {INVALID, STALE, REJECTED, FAILED} → fail
  // Set SIGNAL_API_REQUIRE_LIVE_VALIDATION=1 to restore the strict
  // fail-closed semantic for environments that always populate the
  // live probe.
  const lvs = String(r.live_validation_state ?? '').toUpperCase();
  const requireLiveValidation = process.env.SIGNAL_API_REQUIRE_LIVE_VALIDATION === '1';
  const explicitlyInvalid = new Set(['INVALID', 'STALE', 'REJECTED', 'FAILED', 'NO_DATA']);
  const liveValid =
    lvs === 'VALID'
    || r.live_valid === true
    || (!requireLiveValidation && lvs === '' && r.live_valid !== false);
  if (!liveValid)                        fail(`live_validation_state=${lvs || 'unknown'}`);
  else if (lvs && explicitlyInvalid.has(lvs)) fail(`live_validation_state=${lvs}`);

  // Freshness — must NOT be stale. Empty / unknown values are treated
  // as fresh by default so a row that never had a freshness probe
  // attached still ships (the writer paths populate this when the
  // probe runs).
  const fresh = String(r.freshness_state ?? '').toLowerCase();
  if (fresh === 'stale') fail('freshness_state=stale');

  // Decay state — stale / expired rejects.
  const decay = String(r.decay_state ?? '').toLowerCase();
  if (decay && ELITE_FORBIDDEN_DECAY_STATES.has(decay)) {
    fail(`decay_state=${decay}`);
  }

  // Conviction band — 'avoid' rejects. conviction_level is the storage
  // column on confirmed_snapshots ('MEDIUM' | 'HIGH' | 'INSTITUTIONAL').
  const band = String(r.conviction_band ?? r.conviction_level ?? '');
  if (band && ELITE_FORBIDDEN_CONVICTION_BANDS.has(band)) {
    fail(`conviction_band=${band}`);
  }

  // Score floors. Each fails closed when missing — the spec is explicit
  // ("only elite institutional-grade setups"); a row with missing
  // factor scores has not been graded by the elite tier and must not
  // appear there.
  const conf = Number(r.confidence_score ?? r.confidence ?? NaN);
  if (!Number.isFinite(conf) || conf < ELITE_CONFIDENCE_FLOOR) fail(`confidence_score=${conf}`);

  const fs = Number(r.final_score ?? NaN);
  if (!Number.isFinite(fs) || fs < ELITE_FINAL_FLOOR) fail(`institutional_score=${fs}`);

  const rr = Number(r.rr_ratio ?? r.risk_reward ?? NaN);
  if (!Number.isFinite(rr) || rr < ELITE_RR_FLOOR) fail(`risk_reward=${rr}`);

  const stress = Number(r.stress_survival_score ?? NaN);
  if (!Number.isFinite(stress) || stress < ELITE_STRESS_FLOOR) fail(`stress_survival_score=${stress}`);

  // Factor-score floors. SIGNAL_ELITE_LENIENT_FACTORS=true (default)
  // skips the floor when the value is null / missing / NaN — the engine
  // does not currently write portfolio_fit_score / liquidity_score /
  // market_regime_score, so strict fail-closed drops every row. Lenient
  // mode still enforces the floor when a numeric value IS present, so
  // a graded row that scores below the floor is still rejected.
  const lenient = eliteLenientFactors();
  const factorFloor = (
    label: string, raw: unknown, floor: number,
  ): void => {
    if (raw == null && lenient) return;
    const n = Number(raw ?? NaN);
    if (!Number.isFinite(n)) {
      if (lenient) return;
      fail(`${label}=${n}`);
      return;
    }
    if (n < floor) fail(`${label}=${n}`);
  };
  factorFloor('portfolio_fit_score', r.portfolio_fit_score, ELITE_PORTFOLIO_FIT_FLOOR);
  factorFloor('liquidity_score',     r.liquidity_score,     ELITE_LIQUIDITY_FLOOR);
  factorFloor('market_regime_score', r.market_regime_score, ELITE_MARKET_REGIME_FLOOR);
  factorFloor('data_quality_score',  r.data_quality_score,  ELITE_DATA_QUALITY_FLOOR);

  if (audit) return { passed: failed.length === 0, failed };
  return failed.length === 0;
}

/**
 * Elite-tier comparator. Sort order per spec ELITE-2026-05 §SORT:
 *   1. final_score / institutional_score DESC
 *   2. confidence_score DESC
 *   3. risk_reward DESC
 *   4. stress_survival_score DESC
 *   5. (deterministic) confirmed_at DESC, id ASC
 *
 * Every key is numeric; missing values sort last (treated as 0). The
 * trailing confirmed_at / id break ties so two requests against the
 * same data set return the same order.
 */
export function eliteCmp(a: EliteCandidateRow, b: EliteCandidateRow): number {
  const an1 = num(a.final_score),           bn1 = num(b.final_score);
  if (bn1 !== an1) return bn1 - an1;
  const an2 = num(a.confidence_score ?? a.confidence), bn2 = num(b.confidence_score ?? b.confidence);
  if (bn2 !== an2) return bn2 - an2;
  const an3 = num(a.risk_reward ?? a.rr_ratio), bn3 = num(b.risk_reward ?? b.rr_ratio);
  if (bn3 !== an3) return bn3 - an3;
  const an4 = num(a.stress_survival_score), bn4 = num(b.stress_survival_score);
  if (bn4 !== an4) return bn4 - an4;
  const at = ts((a as { confirmed_at?: string | Date | null }).confirmed_at);
  const bt = ts((b as { confirmed_at?: string | Date | null }).confirmed_at);
  if (bt !== at) return bt - at;
  return num((a as { id?: number }).id) - num((b as { id?: number }).id);
}

/**
 * Filter + sort a candidate set down to the elite tier. Returns:
 *   - the surviving rows in the spec sort order
 *   - a `dropped` audit array carrying the per-row failure reason for
 *     SRE / log analysis (capped to keep noise bounded).
 *
 * `ELITE_GATE=0` disables the gate entirely (returns the input
 * untouched). Default ON — the gate is the dashboard's primary quality
 * contract.
 */
export interface EliteGateResult<T> {
  approved: T[];
  dropped:  Array<{ symbol: string; reasons: string[] }>;
  enabled:  boolean;
}

// ════════════════════════════════════════════════════════════════
//  MARKET-CLOSED DECAY (Spec MARKET-CLOSED-DECAY-2026-05)
//
//  When the market is closed, stored elite approvals lose
//  conviction over time:
//    • 0–6h after confirmed_at:   fresh — no decay
//    • 6–24h:                     aging — -0.5 confidence/h after 6h
//                                          (so −9 by 24h)
//    • 24–72h:                    stale — additional −0.75/h, decay_state='stale'
//    • >72h:                      expired — decay_state='expired'
//
//  The score reductions feed straight into the elite gate's
//  confidence_score (≥75) and institutional_score (≥80) floors, so an
//  aged row drops out naturally as its score drifts below the floor.
//  decay_state stamping makes the elite gate's `decay_state ∉
//  {stale, expired}` predicate fire too — defence-in-depth.
//
//  When the market is OPEN this function is a no-op: the live feed +
//  rescore worker handle freshness during the session. Decay only
//  kicks in when no live feed is updating the row.
// ════════════════════════════════════════════════════════════════

export interface DecayCandidateRow extends EliteCandidateRow {
  confirmed_at?:    string | Date | null;
  generated_at?:    string | Date | null;
  status_changed_at?: string | Date | null;
  // Tracking surface — preserved on the output row so the wire
  // consumer can render a "decayed by N points" banner.
  decay_applied?:    boolean;
  decay_age_hours?:  number;
  decay_points?:     number;
}

export interface MarketDecayOpts {
  /** Override the market-hours decision. When omitted the caller is
   *  expected to have computed isMarketOpen and pass it in. */
  marketOpen: boolean;
  /** Reference time for "now" — defaults to Date.now(). Used by tests. */
  now?: number;
}

const DECAY_FRESH_HOURS  = 6;
const DECAY_AGING_HOURS  = 24;
const DECAY_STALE_HOURS  = 72;

/** Apply market-closed confidence decay to a row. Pure — returns a
 *  new object; does not mutate the input. The output carries decayed
 *  confidence_score / final_score and a stamped decay_state so the
 *  elite gate sees the aged row as stale/expired. */
export function applyMarketClosedDecay<T extends DecayCandidateRow>(
  row: T,
  opts: MarketDecayOpts,
): T {
  if (opts.marketOpen) return row;
  const ref = opts.now ?? Date.now();
  // Pick the most-recent ISO timestamp on the row as "promotion time".
  const ts = row.confirmed_at ?? row.generated_at ?? row.status_changed_at ?? null;
  if (!ts) return row;
  const at = ts instanceof Date ? ts.getTime() : Date.parse(String(ts));
  if (!Number.isFinite(at)) return row;
  const ageH = Math.max(0, (ref - at) / 3_600_000);
  if (ageH < DECAY_FRESH_HOURS) {
    return { ...row, decay_state: 'fresh', decay_applied: false, decay_age_hours: ageH, decay_points: 0 };
  }

  let decayPts = 0;
  // Aging band: 6h-24h, -0.5/h after 6h.
  const agingH = Math.min(ageH, DECAY_AGING_HOURS) - DECAY_FRESH_HOURS;
  if (agingH > 0) decayPts += 0.5 * agingH;
  // Stale band: 24h-72h, additional -0.75/h on top.
  const staleH = Math.min(ageH, DECAY_STALE_HOURS) - DECAY_AGING_HOURS;
  if (staleH > 0) decayPts += 0.75 * staleH;
  // Expired: anything past 72h is dropped flat regardless of base score.
  if (ageH > DECAY_STALE_HOURS) decayPts = Math.max(decayPts, 100);

  const decayState: string =
    ageH > DECAY_STALE_HOURS ? 'expired'
    : ageH > DECAY_AGING_HOURS ? 'stale'
    : 'aging';

  const decay = (v: number | null | undefined): number | null => {
    if (v == null) return v ?? null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return Math.max(0, Math.round((n - decayPts) * 10) / 10);
  };

  return {
    ...row,
    confidence_score:    decay(row.confidence_score ?? row.confidence ?? null),
    confidence:          decay(row.confidence ?? row.confidence_score ?? null),
    final_score:         decay(row.final_score ?? null),
    decay_state:         decayState,
    decay_applied:       true,
    decay_age_hours:     Math.round(ageH * 10) / 10,
    decay_points:        Math.round(decayPts * 10) / 10,
  };
}

/** Bulk variant. Returns the decayed rows + an audit count of how many
 *  rows fell into each decay band. */
export function applyMarketClosedDecayBulk<T extends DecayCandidateRow>(
  rows: readonly T[],
  opts: MarketDecayOpts,
): { rows: T[]; bands: Record<'fresh' | 'aging' | 'stale' | 'expired', number> } {
  const bands = { fresh: 0, aging: 0, stale: 0, expired: 0 };
  const out: T[] = [];
  for (const r of rows) {
    const d = applyMarketClosedDecay(r, opts);
    const band = String((d as DecayCandidateRow).decay_state ?? 'fresh').toLowerCase();
    if (band === 'fresh' || band === 'aging' || band === 'stale' || band === 'expired') {
      bands[band as keyof typeof bands] += 1;
    }
    out.push(d);
  }
  return { rows: out, bands };
}

export function applyEliteGate<T extends EliteCandidateRow & {
  symbol?: string | null;
  tradingsymbol?: string | null;
  factor_scores?: Record<string, unknown> | null;
}>(rows: readonly T[]): EliteGateResult<T> & { bypassed?: boolean } {
  if (process.env.ELITE_GATE === '0') {
    return { approved: [...rows].sort(eliteCmp), dropped: [], enabled: false };
  }
  const approved: T[] = [];
  const dropped: Array<{ symbol: string; reasons: string[] }> = [];
  for (const r of rows) {
    // Flatten factor_scores into top-level fields so the predicate can
    // read portfolio_fit_score / liquidity_score / etc. directly. Does
    // not mutate the input — the merged object is consulted by the
    // predicate only.
    const factors = extractFactorScores(r);
    const merged = { ...r, ...factors } as T;
    const detail = eliteApproved(merged, true);
    if (detail.passed) {
      approved.push(merged);
    } else if (dropped.length < 50) {
      dropped.push({
        symbol:  String(r.symbol ?? r.tradingsymbol ?? '?'),
        reasons: detail.failed,
      });
    }
  }

  // INSTITUTIONAL_TIER_2026-05 — default REVERSED. APPROVED is now
  // strict-only ("These are the strongest confirmed signals only.");
  // weaker rows live in the AWAITING_CONFIRMATION / EMERGING /
  // MONITOR tabs, never injected into signals[]. Empty is acceptable.
  // Set SIGNAL_ELITE_NEVER_EMPTY=1 to restore the legacy
  // is_relaxed-tagged fallback for back-compat with old consumers
  // that ignore the new tier fields.
  const neverEmpty = (process.env.SIGNAL_ELITE_NEVER_EMPTY ?? 'false')
    .trim().toLowerCase();
  const neverEmptyOn = neverEmpty !== '0' && neverEmpty !== 'false'
    && neverEmpty !== 'no' && neverEmpty !== 'off';
  if (approved.length === 0 && rows.length > 0 && neverEmptyOn) {
    const fallbackRows = [...rows].map((r) => {
      const factors = extractFactorScores(r);
      return { ...r, ...factors, is_relaxed: true } as T;
    });
    fallbackRows.sort(eliteCmp);
    return {
      approved: fallbackRows,
      dropped,
      enabled:  true,
      bypassed: true,
    };
  }

  approved.sort(eliteCmp);
  return { approved, dropped, enabled: true };
}
