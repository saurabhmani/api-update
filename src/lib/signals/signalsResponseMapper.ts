// ════════════════════════════════════════════════════════════════
//  signalResponseMapper — pure shape adapters for /api/signals
//
//  This module is the FIRST extraction of route.ts into focused
//  service files (per the refactor plan: confirmedSignalsService,
//  emergingOpportunitiesService, freshnessService, signalResponseMapper).
//
//  Scope of THIS file:
//    - Field-level shaping of a confirmed-snapshot row into the
//      operator-essential `CompactConfirmedSignal` payload returned
//      by the lite=true variant of /api/signals.
//    - Strong typing of the input row so callers in route.ts can
//      drop their `any[]` annotations at this boundary.
//
//  Out of scope (kept in route.ts for now, to be extracted in
//  follow-up commits):
//    - Live-price enrichment (`enrichWithLiveLtp`).
//    - Strict approval gate (`strictApproved`, `confirmedSnapshotCmp`).
//    - Freshness probe / synthetic batch id.
//    - Response envelope assembly.
//
//  No side effects, no DB calls, no Yahoo. Pure functions only.
// ════════════════════════════════════════════════════════════════

import { getStrategyMeta } from '@/lib/signal-engine/strategies/strategyRegistry';
import type { EntryType, StrategyCategory } from '@/lib/signal-engine/types/signalEngine.types';

/**
 * Subset of the confirmed-snapshot row shape that the response
 * mapper actually reads. Kept deliberately wide so existing callers
 * with extra fields (live-price overlays, demoted markers, etc.)
 * pass through without TypeScript friction.
 *
 * Mirror of `ConfirmedSnapshotRow` in
 * `src/lib/signal-engine/repository/readConfirmedSnapshots.ts`,
 * narrowed to just what the response-shape needs. If you add a
 * field to the snapshot reader's output that the API surfaces, add
 * it here too.
 */
export interface ConfirmedSignalRow {
  id?:                              number;
  symbol?:                          string | null;
  tradingsymbol?:                   string | null;
  direction?:                       'BUY' | 'SELL' | string | null;
  entry_price?:                     number | string | null;
  stop_loss?:                       number | string | null;
  target1?:                         number | string | null;
  target2?:                         number | string | null;

  confidence_score?:                number | null;
  confidence?:                      number | null;
  risk_reward?:                     number | null;
  rr_ratio?:                        number | null;
  final_score?:                     number | null;
  classification?:                  string | null;

  profit_percent?:                  number | null;
  loss_percent?:                    number | null;
  expected_edge_percent?:           number | null;
  win_probability?:                 number | null;

  status?:                          string | null;
  valid_until?:                     string | Date | null;
  confirmed_at?:                    string | Date | null;
  invalidation_reason?:             string | null;
  live_invalidated?:                boolean | null;

  /** True ⇒ row is currently tradable (ACTIVE + valid + no invalidation). */
  execution_allowed?:               boolean;
  /** Specific veto reason when execution_allowed=false; null otherwise. */
  rejection_reason?:                string | null;

  livePrice?:                       number | null;
  livePChange?:                     number | null;

  maturity_score?:                  number | null;
  validation_cycles_passed?:        number | null;
  signal_age_minutes_at_promotion?: number | null;
  conviction_level?:                string | null;
  stability_passed?:                boolean | null;
  /** Spec SMART-RELAXED — true when the row passed the relaxed
   *  predicate but NOT the strict main-table gate. The UI renders
   *  "⚠️ Early Signal" instead of "Confirmed" for these rows. */
  is_relaxed?:                      boolean;

  // ── Elite tier fields (Spec ELITE-2026-05) ───────────────────────
  // The elite gate flattens these out of the upstream factor_scores
  // JSON blob into top-level fields so the predicate / wire consumer
  // can read them directly. A row that has been through the elite gate
  // always carries these populated; legacy callers may leave them null.
  /** Phase-4 composite score, also exposed under the institutional
   *  alias so wire consumers can read either name. */
  institutional_score?:             number | null;
  /** Per-factor scores extracted from factor_scores JSON. */
  portfolio_fit_score?:             number | null;
  stress_survival_score?:           number | null;
  liquidity_score?:                 number | null;
  market_regime_score?:             number | null;
  data_quality_score?:              number | null;
  /** Live-engine state. 'VALID' | 'INVALID' | null. */
  live_validation_state?:           string | null;
  /** Tape-vs-snapshot freshness tag — 'fresh' | 'aging' | 'stale'. */
  freshness_state?:                 string | null;
  /** Lifecycle decay tag — 'fresh' | 'aging' | 'stale' | 'expired'. */
  decay_state?:                     string | null;
  /** Conviction band ('high' | 'medium' | 'avoid' | …). */
  conviction_band?:                 string | null;
  /** factor_scores JSON blob the elite gate flattens. */
  factor_scores?:                   Record<string, unknown> | null;
  /** Phase-10 explanation block surfaced for the elite output shape. */
  explanation?:                     Record<string, unknown> | null;

  // ── Rotation fatigue fields (Spec ROTATION-FATIGUE-2026-05) ──────
  // Stamped by responseAssembly after the elite gate so the wire
  // shape carries the rotation context the same row sees in the API.
  // Operators / dashboards read these to spot stocks that have been
  // pinned at the top of the table for too long.
  /** Cycles this symbol has shipped consecutively (since boot/reset). */
  repeat_count?:                    number;
  /** Cycles remaining before the cooldown demotion kicks in. 0 means
   *  the row is currently in cooldown. */
  cooldown_remaining?:              number;
  /** final_score × freshness_weight − cooldown_penalty at shipping
   *  time. The actual ranking score the rotation comparator used. */
  rotation_score?:                  number;
  /** 'fresh' (low repeats) | 'rotating' (mid) | 'fatigued' (cooldown). */
  fatigue_state?:                   'fresh' | 'rotating' | 'fatigued';

  // ── Phase B manipulation surveillance ────────────────────────────
  // Attached by responseAssembly using
  // src/lib/manipulation-engine/manipulationSignalRisk.ts. Stale, no-data,
  // partial, or unknown freshness can never produce a recommendedAction
  // stronger than WARNING_ONLY — see recommendedActionFor() for the rule.
  manipulationRisk?:                import('@/lib/manipulation-engine/manipulationSignalRisk').ManipulationRisk;

  // ── Phase-1 stabilization — strategy metadata ────────────────────
  // q365_signals stores the strategy in `signal_type`, while the
  // confirmed-snapshot reader exposes the same value under `strategy`.
  // The wire mapper reads either name and enriches via strategyRegistry
  // so the API surfaces a typed display name + category + entry type
  // without each consumer having to do its own lookup.
  signal_type?:                     string | null;
  strategy?:                        string | null;
  /** Entry type persisted in q365_phase3_signals.entry_type, when
   *  available. Falls back to the registry mapping if absent. */
  entry_type?:                      string | null;
}

/**
 * Compact response shape — the operator-essential field set returned
 * to clients that pass `?lite=true` to /api/signals?action=all|top.
 * Mobile widgets, status pages, and lightweight monitors consume this.
 */
export interface CompactConfirmedSignal {
  id:                              number | undefined;
  symbol:                          string | null;
  direction:                       string | null;
  /** Spec ELITE-2026-05 §OUTPUT — single binary "decision" that the
   *  elite tier ships: 'BUY' or 'SELL'. Mirrors `direction` so wire
   *  consumers can read either name. */
  decision:                        'BUY' | 'SELL' | string | null;
  entry_price:                     number | string | null;
  stop_loss:                       number | string | null;
  target:                          number | string | null;
  target2:                         number | string | null;
  confidence:                      number | null;
  /** Alias of confidence under the spec name. */
  confidence_score:                number | null;
  risk_reward:                     number | null;
  final_score:                     number | null;
  /** Phase-4 composite under the institutional name. Same value as
   *  final_score; included so wire consumers can read either. */
  institutional_score:             number | null;
  classification:                  string | null;
  profit_percent:                  number | null;
  loss_percent:                    number | null;
  expected_edge_percent:           number | null;
  win_probability:                 number | null;
  status:                          string | null;
  valid_until:                     string | Date | null;
  livePrice:                       number | null;
  maturity_score:                  number | null;
  validation_cycles_passed:        number | null;
  signal_age_minutes_at_promotion: number | null;
  conviction_level:                string | null;
  stability_passed:                boolean | null;
  execution_allowed:               boolean;
  rejection_reason:                string | null;

  // ── Elite tier output fields (Spec ELITE-2026-05 §OUTPUT) ────────
  // The elite gate guarantees these are populated and ≥ their floors
  // for every row in `signals[]`. Wire consumers can sort / filter on
  // them without re-reading factor_scores JSON.
  portfolio_fit_score:             number | null;
  stress_survival_score:           number | null;
  liquidity_score:                 number | null;
  market_regime_score:             number | null;
  data_quality_score:              number | null;
  freshness_state:                 string | null;
  live_validation_state:           string | null;
  /** Phase-10 narrative summary or full block; surfaced for the elite
   *  output shape so the dashboard doesn't need a second round-trip. */
  explanation:                     Record<string, unknown> | string | null;

  // Rotation fatigue — see ConfirmedSignalRow for semantics.
  repeat_count:                    number | null;
  cooldown_remaining:              number | null;
  rotation_score:                  number | null;
  fatigue_state:                   'fresh' | 'rotating' | 'fatigued' | null;

  // ── Phase B manipulation surveillance ────────────────────────────
  // See ConfirmedSignalRow.manipulationRisk. Stale data caps the
  // recommendedAction at WARNING_ONLY; canAffectApproval is true only
  // when freshness is FRESH and band ∈ {ELEVATED, HIGH, SEVERE}.
  manipulationRisk:                import('@/lib/manipulation-engine/manipulationSignalRisk').ManipulationRisk | null;

  // ── Phase-1 stabilization — strategy metadata ────────────────────
  // Resolved once by the wire mapper via strategyRegistry so wire
  // consumers don't have to repeat the lookup. `strategyId` is the
  // raw signal_type from the DB; the other three are enriched.
  /** Raw strategy ID (snake_case) — e.g. "bullish_pullback". Never null. */
  strategyId:                      string;
  /** Title-case display name — e.g. "Bullish Pullback". Never null. */
  strategyName:                    string;
  /** Strategy category — e.g. "pullback", "mean_reversion", "breakdown". */
  strategyCategory:                StrategyCategory;
  /** Strategy-specific entry type — e.g. "pullback_entry". Never null. */
  entryType:                       EntryType;

  source:                          'stored';
}

/**
 * Map a single confirmed-snapshot row to its compact response shape.
 * Pure function — same input → same output, always.
 */
// Spec UI-SIMPLIFY §4 — the API now returns one of four allowed UI
// classifications (no "No Trade", no engine-internal NO_TRADE/REJECTED;
// those rows are filtered out at the gate). Any unknown / missing input
// degrades to UNKNOWN with an error log so operators can see when an
// upstream writer is omitting the column.
type UiClassification = 'CONFIRMED' | 'EARLY_CANDIDATE' | 'DEVELOPING' | 'REVALIDATED' | 'UNKNOWN';

const UI_CLASS_MAP: Record<string, UiClassification> = {
  // "Confirmed" — institutional + high-conviction setups that passed
  // every floor; this is what the operator should treat as actionable.
  INSTITUTIONAL_HIGH_CONVICTION: 'CONFIRMED',
  HIGH_CONVICTION:               'CONFIRMED',
  HIGH_CONVICTION_BUY:           'CONFIRMED',
  CONFIRMED:                     'CONFIRMED',
  VALID_SIGNAL:                  'CONFIRMED',
  VALID_BUY:                     'CONFIRMED',
  // "Early Candidate" — passed the relaxed/early-tier gate; quality is
  // there but conviction hasn't matured. Lighter visual treatment.
  MEDIUM_CONVICTION:             'EARLY_CANDIDATE',
  EARLY_CANDIDATE:               'EARLY_CANDIDATE',
  // "Developing" — still forming. Below floors, but tracker is alive.
  DEVELOPING_SETUP:              'DEVELOPING',
  DEVELOPING:                    'DEVELOPING',
  LOW_CONVICTION:                'DEVELOPING',
  WATCHLIST_ONLY:                'DEVELOPING',
  WATCHLIST:                     'DEVELOPING',
  // "Revalidated" — stored APPROVED but live engine flagged a drift.
  // The detail page renders the banner; surfacing the same label in the
  // table prevents operator confusion.
  REVALIDATED:                   'REVALIDATED',
};

function toUiClassification(raw: string | null | undefined): UiClassification {
  if (!raw) return 'UNKNOWN';
  const k = String(raw).toUpperCase().trim();
  return UI_CLASS_MAP[k] ?? 'UNKNOWN';
}

/**
 * Win-probability normalizer. Two upstream writers produce two different
 * scales — q365_confirmed_signal_snapshots stores 0..1 fractions, while
 * the closed-market q365_signals shaper persists 0..100 percentages. The
 * frontend multiplies by 100 for display, so a 0..100-scale row renders
 * as `6500%`. Force-collapse to a single 0..1 scale at the wire so every
 * downstream consumer sees the same shape.
 *
 * Heuristic: any value > 1 is treated as already-percent and divided by 100.
 * Final result is clamped to [0, 1]. Null/NaN passthrough.
 */
export function normalizeWinProbability(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  const fraction = n > 1 ? n / 100 : n;
  return Math.min(1, Math.max(0, Math.round(fraction * 10000) / 10000));
}

export function compactConfirmedSignal(r: ConfirmedSignalRow): CompactConfirmedSignal {
  // Classification mapping. Use the constrained UI set (CONFIRMED /
  // EARLY_CANDIDATE / DEVELOPING / REVALIDATED) rather than emitting raw
  // engine labels — the dashboard now renders one unified table and only
  // these four labels are valid. Missing or unrecognised inputs degrade to
  // UNKNOWN with a loud error so operators see the gap.
  const classification: UiClassification = toUiClassification(r.classification);
  if (classification === 'UNKNOWN') {
    console.error('[signals.classification] unrecognised classification on confirmed row', {
      symbol:      r.symbol ?? r.tradingsymbol ?? null,
      id:          r.id,
      direction:   r.direction,
      raw:         r.classification ?? null,
      final_score: r.final_score,
    });
  }

  // execution_allowed and rejection_reason fall back to derived values when
  // the upstream reader didn't set them (legacy callers).
  const executionAllowed = r.execution_allowed
    ?? (String(r.status ?? '').toUpperCase() === 'ACTIVE'
        && !r.invalidation_reason
        && !r.live_invalidated);
  const rejectionReason = r.rejection_reason
    ?? r.invalidation_reason
    ?? null;

  // Spec ELITE-2026-05 §OUTPUT — flatten factor_scores JSON into the
  // elite output fields. The elite gate already populates the top-level
  // *_score fields when it runs; the fallbacks here cover legacy paths
  // that bypass the gate (closed-market loader, /api/signals/[id], …).
  const fs = r.factor_scores ?? null;
  const fsNum = (k: string): number | null => {
    if (!fs || typeof fs !== 'object') return null;
    const v = (fs as Record<string, unknown>)[k];
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const portfolioFit = r.portfolio_fit_score ?? fsNum('portfolio_fit') ?? fsNum('portfolio_fit_score');
  const liquidity    = r.liquidity_score     ?? fsNum('liquidity')     ?? fsNum('liquidity_score');
  const regime       = r.market_regime_score ?? fsNum('market_regime') ?? fsNum('market_regime_score');
  const dq           = r.data_quality_score  ?? fsNum('data_quality')  ?? fsNum('data_quality_score');

  // Live validation state — derive from the boolean when the canonical
  // string slot is absent. Spec §OUTPUT requires the string form.
  const liveValidationState = r.live_validation_state
    ?? (r.live_invalidated === true ? 'INVALID'
        : r.execution_allowed === false ? 'INVALID'
        : null);

  // Phase-1 stabilization — enrich strategy metadata from the registry.
  // q365_signals → `signal_type`; q365_confirmed_signal_snapshots → `strategy`.
  const rawStrategy = r.signal_type ?? r.strategy ?? null;
  const strategyMeta = getStrategyMeta(rawStrategy);
  // entry_type can come from q365_phase3_signals (preferred) or the
  // registry mapping (fallback). Never raw null on the wire.
  const entryType: EntryType = (r.entry_type as EntryType | null | undefined)
    ?? strategyMeta.entryType;

  return {
    id:                              r.id,
    symbol:                          r.symbol ?? r.tradingsymbol ?? null,
    direction:                       (r.direction as string | null) ?? null,
    decision:                        (r.direction as string | null) ?? null,
    entry_price:                     r.entry_price ?? null,
    stop_loss:                       r.stop_loss ?? null,
    target:                          r.target1 ?? null,
    target2:                         r.target2 ?? null,
    confidence:                      r.confidence_score ?? r.confidence ?? null,
    confidence_score:                r.confidence_score ?? r.confidence ?? null,
    risk_reward:                     r.risk_reward ?? r.rr_ratio ?? null,
    final_score:                     r.final_score ?? null,
    institutional_score:             r.institutional_score ?? r.final_score ?? null,
    classification,
    profit_percent:                  r.profit_percent ?? null,
    loss_percent:                    r.loss_percent ?? null,
    expected_edge_percent:           r.expected_edge_percent ?? null,
    win_probability:                 normalizeWinProbability(r.win_probability),
    status:                          r.status ?? null,
    valid_until:                     r.valid_until ?? null,
    livePrice:                       r.livePrice ?? null,
    maturity_score:                  r.maturity_score ?? null,
    validation_cycles_passed:        r.validation_cycles_passed ?? null,
    signal_age_minutes_at_promotion: r.signal_age_minutes_at_promotion ?? null,
    conviction_level:                r.conviction_level ?? null,
    stability_passed:                r.stability_passed ?? null,
    execution_allowed:               executionAllowed,
    rejection_reason:                rejectionReason,
    portfolio_fit_score:             portfolioFit,
    stress_survival_score:           r.stress_survival_score ?? null,
    liquidity_score:                 liquidity,
    market_regime_score:             regime,
    data_quality_score:              dq,
    freshness_state:                 r.freshness_state ?? null,
    live_validation_state:           liveValidationState,
    explanation:                     (r.explanation as Record<string, unknown> | null) ?? null,
    repeat_count:                    r.repeat_count ?? null,
    cooldown_remaining:              r.cooldown_remaining ?? null,
    rotation_score:                  r.rotation_score ?? null,
    fatigue_state:                   r.fatigue_state ?? null,
    manipulationRisk:                r.manipulationRisk ?? null,
    // Phase-1 standardized strategy metadata — always populated, never
    // raw null, no "Unknown" leakage. Display name + category + entry
    // type are derived from strategyRegistry so the API contract is the
    // single source of truth for the dashboard / opportunity cards.
    strategyId:                      strategyMeta.strategyId,
    strategyName:                    strategyMeta.strategyName,
    strategyCategory:                strategyMeta.strategyCategory,
    entryType,
    source:                          'stored',
  };
}

/**
 * Bulk variant — convenience for `signals.map(compactConfirmedSignal)`.
 */
export function compactConfirmedSignals(
  rows: readonly ConfirmedSignalRow[],
): CompactConfirmedSignal[] {
  return rows.map(compactConfirmedSignal);
}
