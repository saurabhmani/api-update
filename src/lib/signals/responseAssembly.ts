// ════════════════════════════════════════════════════════════════
//  responseAssembly — pure response-shape builder for /api/signals
//  (action='top'|'all').
//
//  Extracted from the route handler to drop the GET function below
//  300 lines and isolate the wire shape from the orchestration
//  logic. Pure module — no I/O, no DB, no side effects.
//
//  The output shape is the same byte-for-byte envelope the dashboard
//  has consumed since the institutional-filter rewrite:
//    {
//      response_generated_at, request_id, validation_status,
//      empty_confirmed, is_partial_scan, source, latest_batch_id,
//      last_pipeline_run, main_signals_count, buy_count, sell_count,
//      direction_breakdown, signals, emerging_opportunities,
//      emerging_count, count, freshness
//    }
// ════════════════════════════════════════════════════════════════

import {
  compactConfirmedSignal,
  normalizeWinProbability,
  type CompactConfirmedSignal,
  type ConfirmedSignalRow,
} from '@/lib/signals/signalsResponseMapper';
import {
  type FreshnessEnvelope,
} from '@/lib/signals/freshnessService';
import { isInNifty500 } from '@/lib/marketData/nifty500Universe';
import {
  commitRotation,
  annotateRotationFatigue,
  pushRotationStateToRedis,
} from '@/lib/signals/rotationPolicy';
import { recordEliteGateRun } from '@/lib/monitor/institutionalHealth';
import {
  MAIN_TABLE_DISPLAY_CLS,
  applyEliteGate,
  applyMarketClosedDecayBulk,
  ELITE_CONFIDENCE_FLOOR,
  ELITE_FINAL_FLOOR,
  ELITE_RR_FLOOR,
  ELITE_STRESS_FLOOR,
  ELITE_PORTFOLIO_FIT_FLOOR,
  ELITE_LIQUIDITY_FLOOR,
  ELITE_MARKET_REGIME_FLOOR,
  ELITE_DATA_QUALITY_FLOOR,
} from '@/lib/signals/confirmedSignalPolicy';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import { classifyCandleFreshness, logCandleFreshness } from '@/lib/marketData/candleFreshness';
import { logger } from '@/lib/logger';
import { 
  partitionByTier, 
  selectHighPotentialFallback,
  type SignalTier 
} from '@/lib/signals/signalTierClassifier';
import { toDisplayRow, type ShaperRow } from '@/lib/signals/signalDisplayShaper';
import {
  rankSignalsByInstitutionalScore,
  buildClosestToApprovalSignals,
  calculateApprovalGap,
  buildMissingApprovalFactors,
  CLOSEST_TO_APPROVAL_MAX,
  type NearestSignal,
  type SignalSourceTier,
  type RankableSignal,
} from '@/lib/signals/signalRanking';
import {
  buildSignalDueDiligence,
  buildPerformanceReview,
  buildDueDiligenceSummary,
  type DueDiligenceContext,
  type DueDiligenceReview,
  type DueDiligenceSummary,
  type PerformanceReview,
  type SignalTierContext,
  type ReviewedSignalGroup,
} from '@/lib/signals/signalDueDiligence';
import {
  buildLightweightDailyReportPreview,
  type DailyReportPreview,
} from '@/lib/signals/dailySignalReport';
import {
  buildLightweightEngineHealthPreview,
  type EngineHealthPreview,
} from '@/lib/signals/engineHealthMap';
import {
  type ManipulationRisk,
} from '@/lib/manipulation-engine/manipulationSignalRisk';

const log = logger.child({ component: 'responseAssembly' });

/**
 * Lightweight pre-return consistency gate (Spec §6 — main-table consistency).
 * Drops any row whose execution-state would make the stock-detail page
 * disagree with the main table — `invalidation_reason` set, `live_invalidated`
 * true, or `execution_allowed === false`. The detail page (revalidateInstrument)
 * already filters these; mirroring the predicate here means a stale row that
 * leaked from a slow snapshot reader can't ship a BUY in /api/signals while
 * the detail page would render REJECTED.
 *
 * Rejected rows are logged once per call so operators can audit which rows
 * the gate caught — a healthy system rejects nothing here. The function is
 * generic so confirmed-snapshot rows and emerging-tracker rows share the
 * same predicate without a downcast.
 */
export function dropStaleOrConflictingRows<
  T extends {
    symbol?: string | null;
    tradingsymbol?: string | null;
    invalidation_reason?: string | null;
    live_invalidated?: boolean | null;
    execution_allowed?: boolean;
    status?: string | null;
    signal_status?: string | null;
    classification?: string | null;
    raw_classification?: string | null;
  }
>(rows: T[], context: string): T[] {
  if (rows.length === 0) return rows;
  const out: T[] = [];
  const stale: Array<{ symbol: string; reason: string }> = [];
  // Spec INSTITUTIONAL §A + §F — wire-level firewall. Mirrors the
  // detail page's veto logic so a row whose stock-detail page would
  // render REJECTED / NO_STRATEGY can never appear in the main table.
  const NEVER_SHIP_CLS = new Set([
    'NO_TRADE', 'REJECTED',
  ]);
  const NEVER_SHIP_SS = new Set([
    'REJECTED', 'NO_TRADE', 'INVALIDATED',
  ]);
  // BUG-FIX (2026-05) — `status` is the lifecycle column. Only the
  // listed terminal states are real reasons to drop a row. Earlier
  // we did `if (status !== 'ACTIVE') drop`, which exploded the
  // moment a closed-market shaper accidentally leaked the engine
  // signal_status ('APPROVED_SIGNAL') into the lifecycle slot —
  // every approved row was treated as terminal and the response
  // shipped signals=[] while the engine had valid rows. Whitelisting
  // terminals is the safe direction: an unknown status passes
  // through (defensive) instead of zeroing the response.
  const TERMINAL_LIFECYCLE_STATUS = new Set([
    'INVALIDATED', 'EXPIRED', 'STOP_LOSS_HIT', 'TARGET_HIT',
    'CLOSED', 'TERMINATED', 'CANCELLED', 'REJECTED',
  ]);
  for (const r of rows) {
    const sym = String(r.symbol ?? r.tradingsymbol ?? '');
    if (r.invalidation_reason) {
      stale.push({ symbol: sym, reason: `invalidated: ${r.invalidation_reason}` });
      continue;
    }
    if (r.live_invalidated === true) {
      stale.push({ symbol: sym, reason: 'live_invalidated' });
      continue;
    }
    if (r.execution_allowed === false) {
      stale.push({ symbol: sym, reason: 'execution_allowed=false' });
      continue;
    }
    const status = String(r.status ?? '').toUpperCase();
    if (status && TERMINAL_LIFECYCLE_STATUS.has(status)) {
      stale.push({ symbol: sym, reason: `status=${status}` });
      continue;
    }
    const ss = String(r.signal_status ?? '').toUpperCase();
    if (ss && NEVER_SHIP_SS.has(ss)) {
      stale.push({ symbol: sym, reason: `signal_status=${ss}` });
      continue;
    }
    const cls    = String(r.classification ?? '').toUpperCase();
    const rawCls = String(r.raw_classification ?? '').toUpperCase().trim();
    if (cls && NEVER_SHIP_CLS.has(cls)) {
      stale.push({ symbol: sym, reason: `classification=${cls}` });
      continue;
    }
    if (rawCls && NEVER_SHIP_CLS.has(rawCls)) {
      stale.push({ symbol: sym, reason: `raw_classification=${rawCls}` });
      continue;
    }
    // Centralized pipeline maps DEVELOPING_SETUP -> WATCHLIST etc.
    // So we don't drop non-main-table rows here anymore.
    out.push(r);
  }
  if (stale.length > 0) {
    log.warn('signals dropped — stale or conflicting rows leaked into response', {
      context,
      total:    rows.length,
      kept:     out.length,
      dropped:  stale.length,
      sample:   stale.slice(0, 5),
    });
    for (const s of stale) {
      log.info('[RESPONSE_ROW_DROPPED]', { symbol: s.symbol, reason: s.reason, context });
    }
  }
  return out;
}

/**
 * Spec NIFTY500_LOCK_ENABLED §9 — every signal returned to clients
 * MUST have `symbol ∈ NIFTY500_UNIVERSE`. Rows that escape the gate
 * (e.g. legacy confirmed_snapshots written before the lock landed)
 * are rejected at response time. The reject is logged once per call
 * with the offending sample so operators can purge stale rows from
 * MySQL if they accumulate.
 *
 * Bypass via `NIFTY500_LOCK=0` only — the same env switch the
 * resolver honours. When the lock is disabled the function returns
 * the input untouched.
 */
export function filterSignalsToNifty500<T extends { symbol?: string | null; tradingsymbol?: string | null }>(
  rows: T[],
  context: string,
): T[] {
  if (process.env.NIFTY500_LOCK === '0') return rows;
  const out: T[] = [];
  const rejected: string[] = [];
  for (const r of rows) {
    const sym = r?.symbol ?? r?.tradingsymbol ?? '';
    if (sym && isInNifty500(sym)) out.push(r);
    else if (sym) rejected.push(String(sym));
  }
  if (rejected.length > 0) {
    log.warn('signals rejected — outside NIFTY 500 universe', {
      context,
      total: rows.length,
      kept: out.length,
      rejected: rejected.length,
      sample: rejected.slice(0, 5),
    });
  }
  return out;
}

export type ValidationStatus = 'OK' | 'SEASONING_IN_PROGRESS' | 'NO_SIGNALS_CONFIRMED';

/**
 * Validation status semantics:
 *   OK                    — at least one confirmed snapshot is active
 *   SEASONING_IN_PROGRESS — no confirmed yet, but trackers are accumulating
 *                           cycles toward maturity
 *   NO_SIGNALS_CONFIRMED  — nothing confirmed AND nothing to surface
 *                           (genuine empty: scanner hasn't run /
 *                           produced any candidates)
 */
export function deriveValidationStatus(
  finalRowsLength: number,
  inProgressLength: number,
): ValidationStatus {
  if (finalRowsLength > 0)  return 'OK';
  if (inProgressLength > 0) return 'SEASONING_IN_PROGRESS';
  return 'NO_SIGNALS_CONFIRMED';
}

export interface BuildSignalsResponseInput {
  finalRows:            ConfirmedSignalRow[];
  belowFloorDemoted:    ConfirmedSignalRow[];
  inProgressEnriched:   ConfirmedSignalRow[];
  buyCount:             number;
  sellCount:            number;
  freshness:            FreshnessEnvelope;
  syntheticBatchId:     string | null;
  requestId:            string;
  lite:                 boolean;
  validationStatus:     ValidationStatus;
  /** Spec INSTITUTIONAL §B — when the caller knows it will override
   *  `signals` with a fallback set (closed-market loader), suppress the
   *  rotation commit here so the registry isn't decayed against the
   *  empty strict set. Caller must call commitRotation() itself on the
   *  actually-shipped rows. Default false (commit here). */
  skipRotationCommit?:  boolean;
  /** Phase B — Manipulation surveillance integration. The route fetches
   *  this map upstream via getManipulationRiskForSymbols(); when present
   *  the assembler:
   *    1. attaches each row's manipulationRisk envelope before shipping;
   *    2. demotes approved rows whose recommendedAction is
   *       BLOCK_APPROVAL or RISK_RESTRICT (only when canAffectApproval
   *       is true — i.e. fresh + ≥ELEVATED) into the risk-restricted /
   *       rejected tiers with a manipulation-specific rejection reason.
   *  Absent map → no attachment, no gate (safe degradation). */
  manipulationRiskMap?: ReadonlyMap<string, ManipulationRisk>;
}

/** Per-tier impact counters from the manipulation gate. Surfaced on
 *  the response envelope so the daily report and surveillance UI can
 *  show how many candidates the gate touched this cycle. */
export interface ManipulationGateImpact {
  blockedFromApproval:   number;
  riskRestrictedCount:   number;
  penalizedCount:        number;
  warningOnlyCount:      number;
  blockedSymbols:        string[];
  riskRestrictedSymbols: string[];
  active:                boolean;
  dataStatus:            ManipulationRisk['freshnessStatus'];
}

export interface SignalsResponsePayload {
  response_generated_at:  string;
  request_id:             string;
  validation_status:      ValidationStatus;
  empty_confirmed:        boolean;
  is_partial_scan:        false;
  source:                 'confirmed_snapshots';
  latest_batch_id:        string | null;
  last_pipeline_run:      string | null;
  main_signals_count:     number;
  buy_count:              number;
  sell_count:             number;
  direction_breakdown:    { BUY: number; SELL: number };
  signals:                ConfirmedSignalRow[] | CompactConfirmedSignal[];
  /** Spec §EXPECTED RESULT — `approved[]` is a stable alias for
   *  `signals[]`. Same rows, same order, same gating — exposed under
   *  the institutional name so wire consumers can read
   *  `{ approved, rejected, funnel }` without knowing about the
   *  legacy `signals` field. NEVER a different gate. */
  approved:               ConfirmedSignalRow[] | CompactConfirmedSignal[];
  /** Numeric count of Tier 1 approved signals. */
  approvedCount:          number;
  emerging_opportunities: ConfirmedSignalRow[];
  emerging_count:         number;
  count:                  number;
  freshness:              FreshnessEnvelope;
  // Spec INSTITUTIONAL §UX-SIMPLIFY — binary tab model. The
  // institutional `signals[]` array stays exactly as the strict gate
  // produced it. The single `rejected[]` array carries every other
  // scanned row (NO_TRADE / DEVELOPING_SETUP / WATCHLIST_ONLY /
  // invalidated) with a per-row `rejection_code` sub-badge. The
  // funnel summary breaks the rejected count into dominant causes.
  // None of these fields bypass any gate — pure visibility.
  funnel?:                import('@/lib/signals/signalFunnelBuilder').SignalFunnel;
  rejected?:              import('@/lib/signals/signalDisplayShaper').DisplayShape[];
  /** Default UI tab — APPROVED when signals[] is non-empty, REJECTED
   *  otherwise. Only two buckets per spec §UX-SIMPLIFY. */
  default_tab?:           'APPROVED' | 'REJECTED';

  // ── INSTITUTIONAL_TIER_2026-05 ──
  // The five-tier wire fields. The page renders one tab per tier reading
  // these arrays directly. signals[] above is the strict APPROVED
  // tier; the fields below carry every other quality bucket the
  // engine produced.
  high_potential:         ConfirmedSignalRow[] | CompactConfirmedSignal[];
  developing:             ConfirmedSignalRow[] | CompactConfirmedSignal[];
  scanner_candidates:     ConfirmedSignalRow[] | CompactConfirmedSignal[];
  watchlist:              ConfirmedSignalRow[] | CompactConfirmedSignal[];
  risk_restricted:        ConfirmedSignalRow[] | CompactConfirmedSignal[];
  /** True when the high-potential fallback layer (Tier 1.5) engaged. */
  conditional_mode_active: boolean;

  // ── FIX FINAL SIGNAL VISIBILITY 2026-05 ──
  marketStatus?: {
    isOpen: boolean;
    label:  string;
    state:  string;
  };
  dataFreshness?: {
    isStale:    boolean;
    ageMinutes: number | null;
    label:      string;
  };
  provider?:          string;
  isBootstrap?:       boolean;
  isFallback?:        boolean;
  lastApiRequestAt?:  string | null;
  lastSuccessAt?:     string | null;
  lastPipelineRunAt?: string | null;
  lastConfirmedSignalAt?: string | null;
  
  // ── STRUCTURED_SIGNALS_2026-05 ──
  /** Tier 1 — Strict approved signals. Same as signals[]. */
  approvedSignals:        ConfirmedSignalRow[] | CompactConfirmedSignal[];
  /** Tier 1.5 — Strong candidates that missed strict floors but cleared conditional ones. */
  highPotentialSignals:   ConfirmedSignalRow[] | CompactConfirmedSignal[];
  /** Tier 4 — Monitor-only rows. */
  watchlistSignals:       ConfirmedSignalRow[] | CompactConfirmedSignal[];
  /** All non-approved rows (developing, scanner_candidates, watchlist, risk_restricted). */
  rejectedSignals:        any[];

  /** Unified counter block for the top summary cards and diagnostic banners. */
  counters: {
    approvedTotal:       number;
    approvedBuy:         number;
    approvedSell:        number;
    highPotentialTotal:  number;
    watchlistTotal:      number;
    rejectedTotal:       number;
    /** Sum of all non-approved candidates: high_potential + developing + scanner_candidates + watchlist + risk_restricted + rejected. */
    candidateTotal:      number;
  };
  reasonSummary?:        string | null;

  // ── PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05 ──
  /** Wire shape for the "Closest to Approval" UI section. Populated on
   *  every response; the frontend renders the section only when
   *  approvedTotal === 0. Signals are sorted by approvalGap ascending. */
  closestToApproval?: {
    total:        number;
    signals:      ClosestToApprovalRow[];
    generatedAt:  string;
    reason:       string;
  };
  /** Convenience alias for `closestToApproval.signals` — same rows. */
  nearestSignals?: ClosestToApprovalRow[];

  // ── PHASE_2_DUE_DILIGENCE_2026-05 ──
  /** Aggregate due-diligence stats across all reviewed signals on this
   *  response. Used by the Signal Engine page to render the top
   *  "Due Diligence Summary" strip. */
  dueDiligenceSummary?: DueDiligenceSummary;

  // ── PHASE_3_DAILY_INTELLIGENCE_2026-05 ──
  /** Lightweight preview of the Daily Signal Intelligence Report. The
   *  full report lives at /api/signals/daily-report; this preview lets
   *  the Signal Engine page render a small "ready / partial / pending"
   *  badge without an extra round trip. */
  dailyReportPreview?: DailyReportPreview;

  // ── PHASE_5_HEALTH_OBSERVABILITY_2026-05 ──
  /** Lightweight preview of the Engine Health Map. The full health
   *  report lives at /api/signals/engine-health; this preview lets
   *  the Signal Engine page render an overall-status chip + a link. */
  healthPreview?: EngineHealthPreview;

  // ── PHASE_B_MANIPULATION_INTEGRATION ──
  /** Counters describing how the manipulation gate touched this cycle's
   *  signals. `active=false` means the gate was skipped (no risk map
   *  provided, or data is stale and could only warn). */
  manipulationGateImpact?: ManipulationGateImpact;
}

export interface ClosestToApprovalRow {
  symbol:                 string;
  tradingsymbol:          string | null;
  direction:              string | null;
  final_score:            number | null;
  confidence_score:       number | null;
  risk_reward:            number | null;
  approvalGap:            number;
  approvalGapPercent:     number;
  missingApprovalFactors: string[];
  nearestSignalRank:      number;
  sourceTier:             SignalSourceTier;
  isClosestToApproval:    boolean;
  status:                 string;
  is_stale?:              boolean;
  is_bootstrap?:          boolean;
  // PHASE_2_DUE_DILIGENCE_2026-05 — per-row explainability.
  dueDiligence?:          DueDiligenceReview;
  performanceReview?:     PerformanceReview;
}

/**
 * Assemble the /api/signals?action=top|all response payload.
 *
 * The freeze cache and the NextResponse.json wrapping stay in the
 * route handler — those are HTTP concerns, not domain concerns.
 * This builder owns only the JSON body shape.
 *
 * `lite=true` callers receive `compactConfirmedSignal`-mapped rows
 * (operator-essential fields only); everyone else gets the full
 * snapshot row including engine-internal fields.
 *
 * Emerging is the union of in-progress trackers and below-floor
 * demoted rows. Demoted rows already carry
 *   `signal_status: 'DEVELOPING_SETUP'`
 * + `is_demoted: true` from confirmedSignalsService — this builder
 * does NOT re-tag them.
 */
export function buildSignalsResponsePayload(
  input: BuildSignalsResponseInput,
): SignalsResponsePayload {
  const {
    belowFloorDemoted, inProgressEnriched,
    buyCount: rawBuy, sellCount: rawSell, freshness, syntheticBatchId,
    requestId, lite, validationStatus, skipRotationCommit,
    manipulationRiskMap,
  } = input;

  // ── Phase B helpers (no-op when no risk map) ─────────────────────
  // Symbol lookup is uppercased to match getManipulationRiskForSymbols.
  const lookupRisk = (sym: string | null | undefined): ManipulationRisk | undefined => {
    if (!manipulationRiskMap || !sym) return undefined;
    return manipulationRiskMap.get(String(sym).toUpperCase());
  };
  const attachRisk = <T extends { symbol?: string | null; tradingsymbol?: string | null; manipulationRisk?: ManipulationRisk }>(row: T): T => {
    if (!manipulationRiskMap) return row;
    const sym = row.symbol ?? row.tradingsymbol ?? null;
    const risk = lookupRisk(sym);
    if (!risk) return row;
    return { ...row, manipulationRisk: risk };
  };

  // Spec §9 — final response check. finalRows + emerging opportunities
  // MUST be subsets of NIFTY500. Stale rows from before the lock
  // landed are dropped here (last line of defence).
  const nifty500Final     = filterSignalsToNifty500(input.finalRows,         'finalRows');
  const lockedDemoted     = filterSignalsToNifty500(belowFloorDemoted,       'belowFloorDemoted');
  const lockedInProgress  = filterSignalsToNifty500(inProgressEnriched,      'inProgressEnriched');

  // Spec §6 — main-table consistency gate. The main signals[] array MUST
  // never carry a row the stock-detail page would reject. Emerging /
  // demoted rows are NOT subjected to this gate (they're explicitly
  // surfaced as "developing" / "below-floor", so the detail page's
  // REVALIDATED state for them is informational, not a contradiction).
  const consistencyFiltered = dropStaleOrConflictingRows(nifty500Final, 'finalRows');

  // Spec CANDLE-FRESHNESS-2026-05 — global candle-feed health probe.
  // The freshness envelope already carries `candle_age_hours`; convert
  // to a categorical band ('fresh' | 'aging' | 'stale' | 'frozen') and
  // refuse to ship elite rows when the feed is frozen — without live
  // bars, every score on the response is referencing yesterday's tape.
  const marketOpenForDecay = isMarketOpen();
  const candleAgeMs = freshness?.candle_age_hours != null
    ? freshness.candle_age_hours * 3_600_000
    : null;
  // Spec CANDLE-FRESHNESS-2026-05 §source-axis. We don't get the
  // candle source threaded in here yet — the freshness envelope is
  // built upstream and doesn't carry source. We pass undefined and
  // let `classifyCandleFreshness` fall back to the CANDLE_FEED_SOURCE
  // env var, which deployments must set when their candle layer is
  // daily-only (CANDLE_FEED_SOURCE=daily). Future intraday wiring
  // should pass `candle_source` explicitly here.
  const candleReport = classifyCandleFreshness({
    latest_candle_ms: candleAgeMs != null ? Date.now() - candleAgeMs : null,
    market_open:      marketOpenForDecay,
    candle_source:    undefined,
  });
  logCandleFreshness(candleReport, 'responseAssembly');

  // Spec MARKET-CLOSED-DECAY-2026-05 — when the market is closed, the
  // live feed is no longer updating these rows so their conviction
  // should decay with age. Apply BEFORE the elite gate so the elite
  // floors naturally reject rows that aged below threshold (a
  // confidence=80 row at 0h that decays to 71 at 24h fails the ≥75
  // floor and drops out). Stamping decay_state='stale' / 'expired'
  // also fires the elite gate's decay_state predicate. No-op when
  // the market is open — the live feed handles freshness then.
  const decayed = applyMarketClosedDecayBulk(
    consistencyFiltered as Parameters<typeof applyMarketClosedDecayBulk>[0],
    { marketOpen: marketOpenForDecay },
  );
  const decayedRows = decayed.rows as typeof consistencyFiltered;
  if (!marketOpenForDecay && consistencyFiltered.length > 0) {
    log.info('market-closed decay applied', {
      input:  consistencyFiltered.length,
      bands:  decayed.bands,
    });
    console.log('[MARKET_CLOSED_DECAY]', {
      input:    consistencyFiltered.length,
      fresh:    decayed.bands.fresh,
      aging:    decayed.bands.aging,
      stale:    decayed.bands.stale,
      expired:  decayed.bands.expired,
    });
  }

  // Spec ELITE-2026-05 — institutional-grade strict gate. The previous
  // floors (final ≥ 60 / confidence ≥ 55 / rr ≥ 1.5) admitted "balanced
  // band" candidates; this gate requires the elite floors:
  //   confidence ≥ 75, institutional_score (final) ≥ 80, rr ≥ 2.0,
  //   stress ≥ 75, portfolio_fit ≥ 70, liquidity ≥ 60,
  //   market_regime ≥ 65, data_quality ≥ 80.
  // Plus categorical checks: classification ∈ {INSTITUTIONAL_HIGH_CONVICTION,
  // HIGH_CONVICTION}, signal_status = APPROVED_SIGNAL, execution_allowed,
  // live_validation_state = VALID, freshness_state ≠ stale,
  // decay_state ∉ {stale, expired}, conviction_band ≠ avoid.
  // Set ELITE_GATE=0 to bypass (returns to the legacy strict-tier output).
  // Soft Freeze Mode implementation
  const candleAgeMins = candleAgeMs != null ? candleAgeMs / 60000 : 0;
  let freshnessMode: 'NORMAL_OPERATION' | 'WATCHLIST_ONLY_MODE' | 'APPROVAL_FREEZE_MODE' = 'NORMAL_OPERATION';

  if (marketOpenForDecay) {
    if (candleAgeMins <= 15) {
      freshnessMode = 'NORMAL_OPERATION';
    } else if (candleAgeMins <= 45) {
      freshnessMode = 'WATCHLIST_ONLY_MODE';
    } else {
      freshnessMode = 'APPROVAL_FREEZE_MODE';
    }
    if (freshnessMode !== 'NORMAL_OPERATION') {
      log.info('[FRESHNESS_MODE_SWITCH]', { mode: freshnessMode, candleAgeMins });
    }
  }

  if (freshnessMode !== 'NORMAL_OPERATION') {
    console.warn('[ELITE_GATE]', {
      input:        decayedRows.length,
      approved:     0,
      dropped:      decayedRows.length,
      coverage_pct: 0,
      market_open:  marketOpenForDecay,
      gate_reason:  freshnessMode,
      candle_age_seconds: candleReport.candle_age_seconds,
    });
    log.info('[APPROVAL_BLOCKED_STALE_FEED]', { mode: freshnessMode });
    log.info('[WATCHLIST_VISIBLE_DURING_FREEZE]', { mode: freshnessMode });
  }

  // Freeze approvals only. We run the gate but if frozen, approvals are mapped to WATCHLIST 
  // or preserved based on the tier.
  const eliteResultRaw = applyEliteGate(decayedRows);
  
  // Spec SOFT-FREEZE-2026-05 — instead of dropping institutional rows 
  // when the feed is stale, we demote them to the watchlist/developing 
  // bucket. This ensures the operator still sees data (transparency) 
  // but cannot trade them (safety).
  let approvedRows = eliteResultRaw.approved;
  let freezeDemoted: ConfirmedSignalRow[] = [];

  if (freshnessMode !== 'NORMAL_OPERATION') {
    freezeDemoted = approvedRows.map(r => ({
      ...r,
      is_demoted: true,
      demoted_reason: `stale_feed_${freshnessMode.toLowerCase()}`,
      signal_status: 'DEVELOPING_SETUP', // Surfaces in Watchlist tab
    } as ConfirmedSignalRow));
    approvedRows = [];
    
    console.log('[SOFT_FREEZE_DEMOTION]', {
      mode: freshnessMode,
      demoted_count: freezeDemoted.length,
      sample: freezeDemoted.slice(0, 3).map(r => r.symbol)
    });
  }

  // ── PHASE_B_MANIPULATION_GATE ──
  // Apply the manipulation surveillance gate to elite-approved rows.
  // Hard rule (see recommendedActionFor() in manipulationSignalRisk.ts):
  // canAffectApproval is true ONLY when freshnessStatus === 'FRESH' AND
  // band ∈ {ELEVATED, HIGH, SEVERE}. Stale/no-data/partial/unknown
  // freshness can NEVER demote — they only attach a warning.
  let manipulationBlockedRows:        ConfirmedSignalRow[] = [];
  let manipulationRiskRestrictedRows: ConfirmedSignalRow[] = [];
  let manipulationPenalizedCount     = 0;
  let manipulationWarningCount       = 0;
  if (manipulationRiskMap && manipulationRiskMap.size > 0 && approvedRows.length > 0) {
    const survivors: ConfirmedSignalRow[] = [];
    for (const row of approvedRows) {
      const sym = String(row.symbol ?? row.tradingsymbol ?? '').toUpperCase();
      const risk = manipulationRiskMap.get(sym);
      if (!risk || !risk.canAffectApproval) {
        if (risk && (risk.recommendedAction === 'PENALIZE'))     manipulationPenalizedCount++;
        if (risk && (risk.recommendedAction === 'WARNING_ONLY')) manipulationWarningCount++;
        survivors.push(row);
        continue;
      }
      // Fresh + ≥ELEVATED → demote out of approval.
      const annotated: ConfirmedSignalRow = {
        ...row,
        manipulationRisk: risk,
        // Use the existing rejection_reason channel so downstream display
        // shapers (signalDisplayShaper) surface the cause without a new
        // wire field. Safe wording per spec — no claim of proven
        // manipulation; "suspected" / "elevated risk detected" only.
        rejection_reason: risk.recommendedAction === 'BLOCK_APPROVAL'
          ? 'Fresh severe manipulation risk blocked approval'
          : 'Fresh high manipulation risk requires review',
        execution_allowed: false,
        // Re-stamp signal_status so partitionByTier (and any downstream
        // shaper looking at signal_status) puts the row into the right
        // bucket without us re-implementing classification.
        ...(risk.recommendedAction === 'BLOCK_APPROVAL'
              ? { signal_status: 'RISK_RESTRICTED' }
              : { signal_status: 'RISK_RESTRICTED' }),
      } as ConfirmedSignalRow;
      if (risk.recommendedAction === 'BLOCK_APPROVAL') manipulationBlockedRows.push(annotated);
      else                                              manipulationRiskRestrictedRows.push(annotated);
    }
    approvedRows = survivors;
    if (manipulationBlockedRows.length > 0 || manipulationRiskRestrictedRows.length > 0) {
      log.info('[MANIPULATION_GATE] demoted approved rows', {
        blocked:        manipulationBlockedRows.length,
        riskRestricted: manipulationRiskRestrictedRows.length,
        penalized:      manipulationPenalizedCount,
        warningOnly:    manipulationWarningCount,
      });
    }
  }

  // ── INSTITUTIONAL_TIER_2026-05 — Partitioning ──
  // We collect ALL candidates (including those dropped by elite gate)
  // and partition them into the five tabs. This ensures that even
  // when APPROVED is empty, the operator sees rows in DEVELOPING /
  // WATCHLIST / REJECTED.

  // Input for tiering: approvedRows + droppedRows + freezeDemoted +
  // manipulation-demoted rows (they land in risk_restricted via the
  // signal_status='RISK_RESTRICTED' stamp).
  const tierInput = [
    ...approvedRows,
    ...eliteResultRaw.dropped.map(d => decayedRows.find(r => (r.symbol ?? r.tradingsymbol) === d.symbol)).filter(Boolean) as ConfirmedSignalRow[],
    ...freezeDemoted,
    ...manipulationBlockedRows,
    ...manipulationRiskRestrictedRows,
  ];

  const tiers = partitionByTier(tierInput);

  // High-potential fallback (Tier 1.5): if the approved set is empty,
  // we can optionally surface the top-K strongest "near misses" 
  // into Tier 1 as conditional signals.
  const highPotential = approvedRows.length === 0 && (eliteResultRaw.dropped.length > 0 || freezeDemoted.length > 0)
    ? selectHighPotentialFallback([...tierInput])
    : [];

  const eliteResult = {
    ...eliteResultRaw,
    approved: approvedRows,
  };

  if ((eliteResult as { bypassed?: boolean }).bypassed) {
    console.warn('[ELITE_GATE]', {
      input:        decayedRows.length,
      approved:     eliteResult.approved.length,
      gate_action:  'bypassed_never_empty',
      market_open:  marketOpenForDecay,
      hint:         'set SIGNAL_ELITE_NEVER_EMPTY=0 to restore strict empty behaviour',
    });
  }
  // Spec ROTATION-FATIGUE-2026-05 — stamp every shipped row with the
  // current rotation context so wire consumers see repeat_count /
  // cooldown_remaining / rotation_score / fatigue_state. Reads the
  // registry left by the PREVIOUS request's commitRotation; the new
  // commit happens further down on the same shipped set.
  const finalRows = annotateRotationFatigue(eliteResult.approved) as typeof eliteResult.approved;
  // Telemetry — bump the institutional-health counters so SRE can read
  // the gate's pass-rate without parsing logs.
  recordEliteGateRun({
    approved: finalRows.length,
    rejected: eliteResult.dropped.length,
    stale_blocked: !marketOpenForDecay
      ? (decayed.bands.stale + decayed.bands.expired)
      : 0,
    decay_applied: !marketOpenForDecay
      ? (decayed.bands.aging + decayed.bands.stale + decayed.bands.expired)
      : 0,
    market_open: marketOpenForDecay,
  });
  if (eliteResult.enabled) {
    log.info('elite institutional gate applied', {
      input:    decayedRows.length,
      approved: finalRows.length,
      dropped:  eliteResult.dropped.length,
      sample_dropped: eliteResult.dropped.slice(0, 5),
      market_open: marketOpenForDecay,
      decay_bands: !marketOpenForDecay ? decayed.bands : null,
      floors: {
        confidence:      ELITE_CONFIDENCE_FLOOR,
        institutional:   ELITE_FINAL_FLOOR,
        risk_reward:     ELITE_RR_FLOOR,
        stress_survival: ELITE_STRESS_FLOOR,
        portfolio_fit:   ELITE_PORTFOLIO_FIT_FLOOR,
        liquidity:       ELITE_LIQUIDITY_FLOOR,
        market_regime:   ELITE_MARKET_REGIME_FLOOR,
        data_quality:    ELITE_DATA_QUALITY_FLOOR,
      },
    });
    console.log('[ELITE_GATE]', {
      input:    decayedRows.length,
      approved: finalRows.length,
      dropped:  eliteResult.dropped.length,
      coverage_pct: decayedRows.length > 0
        ? Math.round((finalRows.length / decayedRows.length) * 1000) / 10
        : 0,
      market_open: marketOpenForDecay,
    });

    // MATURATION_AUDIT_2026-05 — extended strict-rejection debug. The
    // operator asked for top-20 strongest rejected candidates with the
    // full per-row field set so they can identify which gate is the
    // dominant blocker for graduation into APPROVED. Joins
    // eliteResult.dropped (symbol + reasons) with the input rows by
    // symbol to surface every numeric / categorical field.
    //
    // Output structure:
    //   total_rejected   — total rows the elite gate dropped
    //   cause_histogram  — first-failed-floor frequency across ALL
    //                      dropped rows. Tells the operator at a glance
    //                      which gate is the dominant blocker.
    //   floors_active    — current numeric floors so the histogram is
    //                      contextualised against the active config.
    //   top_by_final     — top-20 dropped rows by final_score with the
    //                      complete diagnostic field set + per-row
    //                      failed_gate / failed_threshold.
    if (!(eliteResult as { bypassed?: boolean }).bypassed && eliteResult.dropped.length > 0) {
      const droppedReasonsBySymbol = new Map<string, string[]>(
        eliteResult.dropped.map((d) => [d.symbol, d.reasons]),
      );
      // Map a failure-reason string to its (gate, threshold) pair so
      // the audit log can answer "which gate, at what threshold,
      // killed this row?" without forcing the operator to parse the
      // raw reason string.
      const gateThresholdFor = (
        reason: string,
      ): { gate: string; threshold: string | number | null } => {
        const eq = reason.indexOf('=');
        const head = eq >= 0 ? reason.slice(0, eq) : reason;
        const tail = eq >= 0 ? reason.slice(eq + 1) : '';
        const floors: Record<string, number> = {
          institutional_score:    ELITE_FINAL_FLOOR,
          final_score:            ELITE_FINAL_FLOOR,
          confidence:             ELITE_CONFIDENCE_FLOOR,
          confidence_score:       ELITE_CONFIDENCE_FLOOR,
          risk_reward:            ELITE_RR_FLOOR,
          rr_ratio:               ELITE_RR_FLOOR,
          stress:                 ELITE_STRESS_FLOOR,
          stress_survival_score:  ELITE_STRESS_FLOOR,
          portfolio_fit_score:    ELITE_PORTFOLIO_FIT_FLOOR,
          liquidity_score:        ELITE_LIQUIDITY_FLOOR,
          market_regime_score:    ELITE_MARKET_REGIME_FLOOR,
          data_quality_score:     ELITE_DATA_QUALITY_FLOOR,
        };
        const canonicalGate =
          head === 'institutional_score' ? 'final_score'
          : head === 'rr_ratio'           ? 'risk_reward'
          : head === 'stress'             ? 'stress_survival'
          : head === 'confidence_score'   ? 'confidence'
          : head;
        return {
          gate:      canonicalGate,
          threshold: floors[head] ?? (tail || null),
        };
      };

      const droppedAudit = (decayedRows as unknown as readonly Record<string, unknown>[])
        .map((r) => {
          const sym = String((r.symbol ?? r.tradingsymbol ?? '?') as string | number);
          const reasons = droppedReasonsBySymbol.get(sym);
          if (!reasons) return null;
          const num = (v: unknown): number | null => {
            if (v == null) return null;
            const n = typeof v === 'number' ? v : Number(v);
            return Number.isFinite(n) ? n : null;
          };
          const firstReason = reasons[0] ?? 'unknown';
          const { gate: failedGate, threshold: failedThreshold } = gateThresholdFor(firstReason);
          return {
            symbol:            sym,
            confidence:        num(r.confidence_score ?? r.confidence),
            final_score:       num(r.final_score),
            maturity_score:    num(r.maturity_score),
            rr:                num(r.rr_ratio ?? r.risk_reward),
            liquidity_score:   num(r.liquidity_score),
            portfolio_fit:     num(r.portfolio_fit_score),
            stress_survival:   num(r.stress_survival_score),
            market_regime:     num(r.market_regime_score),
            data_quality:      num(r.data_quality_score),
            freshness_state:   String((r.freshness_state ?? '') as string).toUpperCase() || null,
            decay_state:       String((r.decay_state ?? '') as string).toLowerCase() || null,
            execution_allowed: r.execution_allowed === false ? false : r.execution_allowed === true ? true : null,
            signal_status:     String((r.signal_status ?? '') as string).toUpperCase() || null,
            classification:    String((r.classification ?? r.raw_classification ?? '') as string).toUpperCase() || null,
            live_validation_state: String((r.live_validation_state ?? '') as string).toUpperCase() || null,
            failed_gate:       failedGate,
            failed_threshold:  failedThreshold,
            rejection_reason:  firstReason,
            all_failures:      reasons,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null)
        .sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
        .slice(0, 20);

      // Histogram of dominant rejection causes — the single most useful
      // line for "is FINAL score the bottleneck or is it something else?".
      // Reused gateThresholdFor on the FIRST failure of each dropped
      // row so the histogram reflects the dominant blocker per row.
      const causeHistogram: Record<string, number> = {};
      for (const reasons of droppedReasonsBySymbol.values()) {
        const first = reasons[0] ?? 'unknown';
        const { gate } = gateThresholdFor(first);
        causeHistogram[gate] = (causeHistogram[gate] ?? 0) + 1;
      }
      console.log('[STRICT_REJECTION_DEBUG]', {
        total_rejected:   eliteResult.dropped.length,
        cause_histogram:  causeHistogram,
        floors_active: {
          confidence:           ELITE_CONFIDENCE_FLOOR,
          final:                ELITE_FINAL_FLOOR,
          risk_reward:          ELITE_RR_FLOOR,
          stress_survival:      ELITE_STRESS_FLOOR,
          portfolio_fit:        ELITE_PORTFOLIO_FIT_FLOOR,
          liquidity:            ELITE_LIQUIDITY_FLOOR,
          market_regime:        ELITE_MARKET_REGIME_FLOOR,
          data_quality:         ELITE_DATA_QUALITY_FLOOR,
        },
        top_by_final:     droppedAudit,
      });

      // MATURATION_AUDIT_2026-05 — single-line APPROVAL_BOTTLENECK
      // for the elite-gate failure mode. Fires only when the elite
      // gate dropped EVERY row from a non-empty input (i.e., strict
      // passed N rows but elite killed all of them). The
      // confirmedSignalsService bottleneck log covers strict + freshness
      // failure modes; this one covers the elite-gate failure mode.
      if (finalRows.length === 0 && decayedRows.length > 0) {
        const ranked = Object.entries(causeHistogram).sort((a, b) => b[1] - a[1]);
        const dominant = ranked[0]?.[0] ?? 'unknown';
        const dominantCount = ranked[0]?.[1] ?? 0;
        const suggestion = (() => {
          if (dominant === 'final_score')           return 'SIGNAL_API_ELITE_FINAL_FLOOR=55 (currently 60)';
          if (dominant === 'risk_reward')           return 'SIGNAL_API_ELITE_RR_FLOOR=1.8 (currently 2.0)';
          if (dominant === 'confidence')            return 'SIGNAL_API_ELITE_CONFIDENCE_FLOOR=65 (currently 70)';
          if (dominant === 'stress_survival')       return 'SIGNAL_API_ELITE_STRESS_FLOOR=50 (currently 60)';
          if (dominant === 'classification')        return 'engine is producing classifications outside elite whitelist (INSTITUTIONAL_HIGH_CONVICTION, HIGH_CONVICTION, VALID_SIGNAL); fix Phase 4, not the gate';
          if (dominant === 'freshness_state')       return 'rows are aging past the freshness cap before reaching elite — increase cap or check candle pipeline';
          if (dominant === 'decay_state')           return 'market_closed_decay is tagging rows stale/expired — see applyMarketClosedDecayBulk thresholds';
          if (dominant === 'live_validation_state') return 'engine is setting live_validation_state to a non-VALID value — check live revalidation logic';
          return `inspect [STRICT_REJECTION_DEBUG].top_by_final for rows with rejection_reason starting "${dominant}"`;
        })();
        console.log('[APPROVAL_BOTTLENECK]', {
          stage:           'elite_gate',
          cause:           dominant,
          blocked_rows:    dominantCount,
          total_input:     decayedRows.length,
          pct_blocked:     Math.round((dominantCount / decayedRows.length) * 100),
          ranked_causes:   ranked.slice(0, 5),
          detail:          `Strict gate produced ${decayedRows.length} candidates but elite gate rejected all of them. Dominant blocker: "${dominant}" (${dominantCount} rows = ${Math.round((dominantCount / decayedRows.length) * 100)}%).`,
          suggested_env:   suggestion,
        });
      }
    }
  }

  // Spec UI-SIMPLIFY §1 — emerging_opportunities[] is the union of 
  // in-progress trackers (SEASONING) and below-floor demoted rows.
  // We also include the soft-freeze demotions here so they surface 
  // in the Watchlist tab during feed stalls.
  const mergedEmerging: ConfirmedSignalRow[] = [
    ...lockedDemoted,
    ...lockedInProgress
  ];
  
  // Spec INSTITUTIONAL-RECOVERY-2026-05 — if we have freeze demoted 
  // signals, they are added to emerging so they don't vanish.
  if (typeof freezeDemoted !== 'undefined' && freezeDemoted.length > 0) {
    // Add to the front so they are prominent in the developing pool
    mergedEmerging.unshift(...freezeDemoted);
  }

  // Final count for the emerging bucket
  const emergingCount = mergedEmerging.length;

  // BUY / SELL counts must reflect the post-lock + post-consistency set or
  // the dashboard tile counts will mismatch the rendered list. Recompute
  // unconditionally now that two filters can shrink the set; the previous
  // length-equality short-circuit only caught the NIFTY-500 lock.
  const buyCount  = finalRows.filter((r) => String((r as ConfirmedSignalRow).direction ?? '').toUpperCase() === 'BUY').length;
  const sellCount = finalRows.filter((r) => String((r as ConfirmedSignalRow).direction ?? '').toUpperCase() === 'SELL').length;
  void rawBuy; void rawSell; // input counters retained for legacy callers; superseded by the recompute above.

  // Spec INSTITUTIONAL §B — bump per-symbol rotation counters with the
  // rows we are actually about to ship. This is the registry the
  // rotationCmp comparator consults next request: a row that has been
  // shipped > COOLDOWN_MAX_CYCLES consecutive times gets a deterministic
  // score penalty so a fresher candidate can leapfrog it. Without this
  // call, AADHARHFC-style "stuck for 24h+" pinning is the steady state.
  //
  // skipRotationCommit=true is honoured by the route handler when it
  // knows the closed-market fallback will replace `signals[]` — that
  // caller commits rotation against the ACTUAL shipped set so the
  // registry tracks what the dashboard saw, not the empty strict pool.
  if (!skipRotationCommit) {
    try { commitRotation(finalRows); } catch (e) {
      log.warn('commitRotation failed — rotation registry not updated this cycle', { err: (e as Error).message });
    }
    // Spec DISTRIBUTED-ROTATION-2026-05 — fire-and-forget Redis push
    // so peer replicas see this commit on their next pull cycle. The
    // push is throttled internally to once per sync interval, so a
    // tight burst of requests doesn't hammer Redis.
    void pushRotationStateToRedis().catch(() => undefined);
  }

  // Spec INSTITUTIONAL §D — defensive normalize for the FULL row path
  // (lite=false). The lite path applies normalizeWinProbability inside
  // compactConfirmedSignal already; the full path was returning the row
  // verbatim, so any leg that wrote 0..100 directly into win_probability
  // (legacy q365_signals rows pre-normalization) would render as 5000%
  // / 5900% on the frontend (which always multiplies by 100). Clamp to
  // [0, 1] here so the wire shape is the single source of truth and the
  // UI can render `(value * 100).toFixed(1) + '%'` without re-checking.
  const fullSignals: ConfirmedSignalRow[] = lite ? [] : finalRows.map((r) => {
    const wp = normalizeWinProbability(r.win_probability ?? null);
    return wp == null || wp === r.win_probability ? r : { ...r, win_probability: wp };
  });

  // Spec §EXPECTED RESULT — single source of truth for the
  // institutional approved set. `signals` and `approved` MUST point
  // at byte-identical arrays so a wire consumer reading either field
  // sees the same rows. Compute once, ship twice.
  const shippedSignals = lite ? finalRows.map(compactConfirmedSignal) : fullSignals;

  // ── PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05 ──
  // Universal ranking — every tier list must be sorted by highest
  // final score first. The strict gate upstream already filters; the
  // ranking step here is purely about presentation order so each tab
  // surfaces its best candidate first. Categories are NOT mixed.
  //
  // PHASE_B — every ranked tier is then run through attachRisk() so
  // each row carries its manipulationRisk envelope on the wire.
  const rankedApproved          = rankSignalsByInstitutionalScore(shippedSignals as unknown as RankableSignal[]).map(attachRisk) as typeof shippedSignals;
  const rankedHighPotential     = rankSignalsByInstitutionalScore(highPotential as unknown as RankableSignal[]).map(attachRisk) as typeof highPotential;
  const rankedDeveloping        = rankSignalsByInstitutionalScore(tiers.developing as unknown as RankableSignal[]).map(attachRisk) as typeof tiers.developing;
  const rankedScannerCandidates = rankSignalsByInstitutionalScore(tiers.scannerCandidates as unknown as RankableSignal[]).map(attachRisk) as typeof tiers.scannerCandidates;
  const rankedWatchlist         = rankSignalsByInstitutionalScore(tiers.watchlist as unknown as RankableSignal[]).map(attachRisk) as typeof tiers.watchlist;
  const rankedRiskRestricted    = rankSignalsByInstitutionalScore(tiers.riskRestricted as unknown as RankableSignal[]).map(attachRisk) as typeof tiers.riskRestricted;
  const rankedEmerging          = rankSignalsByInstitutionalScore(mergedEmerging as unknown as RankableSignal[]).map(attachRisk) as typeof mergedEmerging;

  const liteHighPotential       = lite ? rankedHighPotential.map(compactConfirmedSignal)       : rankedHighPotential;
  const liteDeveloping          = lite ? rankedDeveloping.map(compactConfirmedSignal)          : rankedDeveloping;
  const liteScannerCandidates   = lite ? rankedScannerCandidates.map(compactConfirmedSignal)   : rankedScannerCandidates;
  const liteWatchlist           = lite ? rankedWatchlist.map(compactConfirmedSignal)           : rankedWatchlist;
  const liteRiskRestricted      = lite ? rankedRiskRestricted.map(compactConfirmedSignal)      : rankedRiskRestricted;

  // Sorted rejected rows (display shape) — first by final_score from
  // the source row, then ranked by the display table's own fields so
  // the highest-final-score rejected row tops the list.
  const rejectedDisplayRows = eliteResult.dropped.map(d => {
    const row = (decayedRows as any[]).find(r => (r.symbol ?? r.tradingsymbol) === d.symbol);
    return toDisplayRow({
      ...row,
      rejection_reason: d.reasons[0],
      rejection_codes:  d.reasons,
    } as ShaperRow);
  });
  const rankedRejectedDisplay = [...rejectedDisplayRows].sort((a, b) => {
    const fb = Number(b.final_score ?? 0);
    const fa = Number(a.final_score ?? 0);
    if (fb !== fa) return fb - fa;
    const cb = Number(b.confidence ?? 0);
    const ca = Number(a.confidence ?? 0);
    if (cb !== ca) return cb - ca;
    const rb = Number(b.rr ?? 0);
    const ra = Number(a.rr ?? 0);
    return rb - ra;
  });

  // ── Closest to Approval ──
  // Built only when the approved set is empty; surfaces the top
  // candidates from the non-approved pools with a per-row approval
  // gap + missing factors so the UI can explain "why not approved".
  // Hard-invalidated rows are excluded inside the helper.
  const closestToApprovalRows: ClosestToApprovalRow[] = finalRows.length === 0
    ? buildClosestToApprovalSignals(
        {
          highPotential:    rankedHighPotential as unknown as RankableSignal[],
          watchlist:        rankedWatchlist as unknown as RankableSignal[],
          developing:       rankedDeveloping as unknown as RankableSignal[],
          scannerCandidates: rankedScannerCandidates as unknown as RankableSignal[],
          // Rejected display rows do not carry every original field;
          // we re-tap the decayedRows pool for soft-rejection candidates.
          rejected:         decayedRows as unknown as RankableSignal[],
        },
        CLOSEST_TO_APPROVAL_MAX,
      ).map((n: NearestSignal): ClosestToApprovalRow => {
        const s = n.signal as RankableSignal;
        const symbol = String(s.symbol ?? s.tradingsymbol ?? '');
        const tier = n.sourceTier;
        const status = tier === 'high_potential'    ? 'High Potential'
                     : tier === 'watchlist'         ? 'Watchlist'
                     : tier === 'developing'        ? 'Awaiting Confirmation'
                     : tier === 'scanner_candidate' ? 'Emerging Opportunity'
                     :                                'Rejected (Soft)';
        const freshness = String(s.freshness_state ?? '').toUpperCase();
        const decay     = String(s.decay_state ?? '').toLowerCase();
        const isStale   = freshness === 'STALE' || decay === 'stale' || decay === 'aging';
        return {
          symbol,
          tradingsymbol:          s.tradingsymbol ?? symbol,
          direction:              s.direction ?? null,
          final_score:            s.final_score ?? null,
          confidence_score:       s.confidence_score ?? s.confidence ?? null,
          risk_reward:            s.risk_reward ?? s.rr_ratio ?? null,
          approvalGap:            n.approvalGap,
          approvalGapPercent:     n.approvalGapPercent,
          missingApprovalFactors: n.missingApprovalFactors,
          nearestSignalRank:      n.nearestSignalRank,
          sourceTier:             n.sourceTier,
          isClosestToApproval:    n.isClosestToApproval,
          status,
          is_stale:               isStale || undefined,
        };
      })
    : [];

  const closestToApprovalReason = finalRows.length === 0
    ? (!marketOpenForDecay
        ? 'Market Closed — nearest candidates from last close. Awaiting fresh market confirmation.'
        : 'No approved signal is available right now. Showing nearest candidates by final score and approval gap.')
    : 'Approved signals available — closest-to-approval surfaced for reference only.';

  // ── PHASE_2_DUE_DILIGENCE_2026-05 ──
  // Build per-row dueDiligence + performanceReview and attach to each
  // tier list. The strict gate is NOT touched; we only enrich the
  // shipped payload so the UI can render explainability.
  const dueDiligenceContext: DueDiligenceContext = {
    tier:              'approved', // placeholder; tier is overridden per row below.
    marketOpen:        marketOpenForDecay,
    marketLabel:       marketOpenForDecay ? 'Market Open' : 'Market Closed',
    isBootstrap:       false, // closed-market route may override at the route layer.
    isFallback:        freshnessMode !== 'NORMAL_OPERATION',
    freshnessMode,
    candleAgeMinutes:  Math.round(candleAgeMins),
  };

  const enrichRowsWithDiligence = <T extends { symbol?: string | null; tradingsymbol?: string | null }>(
    rows: readonly T[],
    tier: SignalTierContext,
  ): Array<T & { dueDiligence: DueDiligenceReview; performanceReview: PerformanceReview }> => {
    if (!rows || rows.length === 0) return [];
    return rows.map((r) => {
      const ctx: DueDiligenceContext = { ...dueDiligenceContext, tier };
      const performance = buildPerformanceReview(r as unknown as RankableSignal, ctx);
      const dd          = buildSignalDueDiligence(r as unknown as RankableSignal, ctx, performance);
      return { ...r, dueDiligence: dd, performanceReview: performance };
    });
  };

  const enrichedApproved        = enrichRowsWithDiligence(rankedApproved as any[], 'approved');
  const enrichedHighPotential   = enrichRowsWithDiligence(liteHighPotential as any[], 'high_potential');
  const enrichedWatchlist       = enrichRowsWithDiligence(liteWatchlist as any[], 'watchlist');
  const enrichedDeveloping      = enrichRowsWithDiligence(liteDeveloping as any[], 'developing');
  const enrichedScannerCandidates = enrichRowsWithDiligence(liteScannerCandidates as any[], 'scanner_candidate');
  const enrichedRiskRestricted  = enrichRowsWithDiligence(liteRiskRestricted as any[], 'risk_restricted');

  // The rejected display rows already passed through `toDisplayRow`,
  // which trims the original signal fields. Enrich from the source
  // decayedRows pool by matching symbol so dueDiligence sees the full
  // factor breakdown.
  const enrichedRejectedDisplay = rankedRejectedDisplay.map((dRow) => {
    const src = (decayedRows as any[]).find(
      (r) => (r.symbol ?? r.tradingsymbol) === dRow.symbol,
    );
    const ctx: DueDiligenceContext = { ...dueDiligenceContext, tier: 'rejected' };
    const performance = buildPerformanceReview((src ?? dRow) as unknown as RankableSignal, ctx);
    const dd          = buildSignalDueDiligence((src ?? dRow) as unknown as RankableSignal, ctx, performance);
    return { ...dRow, dueDiligence: dd, performanceReview: performance };
  });

  // Enrich closest-to-approval rows. We re-derive context.tier so the
  // diligence summary phrasing matches the row's true source pool.
  const enrichedClosestToApproval: ClosestToApprovalRow[] = closestToApprovalRows.map((row) => {
    // Find the source row by symbol in the closed/decayed pools so we
    // have factor_scores / freshness for full diligence.
    const src = (decayedRows as any[]).find((r) => (r.symbol ?? r.tradingsymbol) === row.symbol)
             ?? row;
    const sourceTierForCtx: SignalTierContext = row.sourceTier === 'high_potential' ? 'high_potential'
                                              : row.sourceTier === 'watchlist'       ? 'watchlist'
                                              : row.sourceTier === 'developing'      ? 'developing'
                                              : row.sourceTier === 'scanner_candidate' ? 'scanner_candidate'
                                              :                                          'nearest';
    const ctx: DueDiligenceContext = { ...dueDiligenceContext, tier: sourceTierForCtx };
    const performance = buildPerformanceReview(src as unknown as RankableSignal, ctx);
    const dd          = buildSignalDueDiligence(src as unknown as RankableSignal, ctx, performance);
    return { ...row, dueDiligence: dd, performanceReview: performance };
  });

  // Aggregate due-diligence summary. Reads across every tier so the
  // page can render a single header strip with the top blockers.
  const reviewGroups: ReviewedSignalGroup[] = [
    { signals: rankedApproved as unknown as RankableSignal[],         tier: 'approved' },
    { signals: liteHighPotential as unknown as RankableSignal[],      tier: 'high_potential' },
    { signals: liteWatchlist as unknown as RankableSignal[],          tier: 'watchlist' },
    { signals: liteDeveloping as unknown as RankableSignal[],         tier: 'developing' },
    { signals: liteScannerCandidates as unknown as RankableSignal[],  tier: 'scanner_candidate' },
    { signals: liteRiskRestricted as unknown as RankableSignal[],     tier: 'risk_restricted' },
    { signals: decayedRows as unknown as RankableSignal[],            tier: 'rejected' }, // includes elite-dropped rows
  ];
  const dueDiligenceSummary = buildDueDiligenceSummary(reviewGroups, dueDiligenceContext);

  // ── PHASE_3_DAILY_INTELLIGENCE_2026-05 — lightweight preview ──
  // Reuse the per-row performanceReview already enriched onto each
  // row so the preview is cheap. movePercent < 0.5 counts as failed,
  // > 0.5 counts as success, otherwise pending.
  const countOutcome = (rows: Array<{ performanceReview?: PerformanceReview }>): { success: number | null; failed: number | null; withOutcome: number } => {
    let success = 0, failed = 0, withOutcome = 0;
    for (const r of rows) {
      const m = r.performanceReview?.movePercent;
      if (m == null) continue;
      withOutcome++;
      if (m >= 0.5)      success++;
      else if (m <= -0.5) failed++;
    }
    return {
      success: withOutcome > 0 ? success : null,
      failed:  withOutcome > 0 ? failed  : null,
      withOutcome,
    };
  };
  const approvedOutcome      = countOutcome(enrichedApproved as Array<{ performanceReview?: PerformanceReview }>);
  const highPotentialOutcome = countOutcome(enrichedHighPotential as Array<{ performanceReview?: PerformanceReview }>);

  const dailyReportPreview = buildLightweightDailyReportPreview({
    approvedTotal:           enrichedApproved.length,
    approvedSuccess:         approvedOutcome.success,
    approvedFailed:          approvedOutcome.failed,
    highPotentialTotal:      enrichedHighPotential.length,
    highPotentialPerformed:  highPotentialOutcome.success,
    watchlistTotal:          enrichedWatchlist.length + enrichedDeveloping.length + enrichedScannerCandidates.length,
    rejectedTotal:           enrichedRiskRestricted.length + enrichedRejectedDisplay.length,
    topBlockReason:          dueDiligenceSummary.topBlockReasons[0]?.reason ?? null,
    marketOpen:              marketOpenForDecay,
    isBootstrap:             false, // route layer overrides for closed-market path
    isFallback:              freshnessMode !== 'NORMAL_OPERATION',
    staleMinutes:            Math.round(candleAgeMins),
  });

  // ── PHASE_5_HEALTH_OBSERVABILITY_2026-05 — lightweight preview ──
  const healthPreview = buildLightweightEngineHealthPreview({
    marketOpen:     marketOpenForDecay,
    isBootstrap:    false,
    isFallback:     freshnessMode !== 'NORMAL_OPERATION',
    staleMinutes:   Math.round(candleAgeMins),
    approvedTotal:  enrichedApproved.length,
    candidateTotal: enrichedHighPotential.length
                  + enrichedWatchlist.length
                  + enrichedDeveloping.length
                  + enrichedScannerCandidates.length
                  + enrichedRiskRestricted.length
                  + enrichedRejectedDisplay.length,
  });

  return {
    response_generated_at:  new Date().toISOString(),
    request_id:             requestId,
    validation_status:      validationStatus,
    empty_confirmed:        finalRows.length === 0,
    is_partial_scan:        false,
    source:                 'confirmed_snapshots',
    latest_batch_id:        syntheticBatchId,
    last_pipeline_run:      freshness.last_pipeline_run,
    main_signals_count:     finalRows.length,
    buy_count:              buyCount,
    sell_count:             sellCount,
    direction_breakdown:    { BUY: buyCount, SELL: sellCount },
    signals:                enrichedApproved as typeof rankedApproved,
    approved:               enrichedApproved as typeof rankedApproved,
    emerging_opportunities: rankedEmerging,
    emerging_count:         emergingCount,
    count:                  enrichedApproved.length,
    freshness:              freshness,

    // Tiers for the dashboard — each sorted by highest final score first
    // and enriched with per-row dueDiligence + performanceReview.
    high_potential:         enrichedHighPotential as typeof liteHighPotential,
    developing:             enrichedDeveloping as typeof liteDeveloping,
    scanner_candidates:     enrichedScannerCandidates as typeof liteScannerCandidates,
    watchlist:              enrichedWatchlist as typeof liteWatchlist,
    risk_restricted:        enrichedRiskRestricted as typeof liteRiskRestricted,
    conditional_mode_active: highPotential.length > 0,

    // ── FIX FINAL SIGNAL VISIBILITY 2026-05 ──
    marketStatus: {
      isOpen: marketOpenForDecay,
      label:  marketOpenForDecay ? 'Market Open' : 'Market Closed',
      state:  marketOpenForDecay ? 'open' : 'closed',
    },
    dataFreshness: {
      isStale:    candleAgeMins > 30,
      ageMinutes: Math.round(candleAgeMins),
      label:      candleReport.freshness_quality,
    },
    provider:          freshness.kite_health.source ?? 'unknown',
    isBootstrap:       false, // Overridden in route.ts if applicable
    isFallback:        freshnessMode !== 'NORMAL_OPERATION',
    lastApiRequestAt:  null, // Populated in route.ts
    lastSuccessAt:     null, // Populated in route.ts
    lastPipelineRunAt: freshness.last_pipeline_run,
    lastConfirmedSignalAt: freshness.signal_latest_generated,
    
    approvedSignals:      enrichedApproved as typeof rankedApproved,
    highPotentialSignals: enrichedHighPotential as typeof liteHighPotential,
    watchlistSignals:     enrichedWatchlist as typeof liteWatchlist,
    rejectedSignals:      enrichedRejectedDisplay,

    counters: {
      approvedTotal:       finalRows.length,
      approvedBuy:         buyCount,
      approvedSell:        sellCount,
      highPotentialTotal:  highPotential.length,
      watchlistTotal:      tiers.watchlist.length + tiers.developing.length + tiers.scannerCandidates.length,
      rejectedTotal:       eliteResult.dropped.length + tiers.riskRestricted.length,
      candidateTotal:      highPotential.length +
                           tiers.developing.length +
                           tiers.scannerCandidates.length +
                           tiers.watchlist.length +
                           tiers.riskRestricted.length +
                           eliteResult.dropped.length,
    },
    approvedCount:         finalRows.length,
    reasonSummary:         eliteResult.dropped.length > 0 ? eliteResult.dropped[0].reasons[0] : null,

    // ── PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05 ──
    closestToApproval: {
      total:        enrichedClosestToApproval.length,
      signals:      enrichedClosestToApproval,
      generatedAt:  new Date().toISOString(),
      reason:       closestToApprovalReason,
    },
    nearestSignals: enrichedClosestToApproval,

    // ── PHASE_2_DUE_DILIGENCE_2026-05 ──
    dueDiligenceSummary,

    // ── PHASE_3_DAILY_INTELLIGENCE_2026-05 ──
    dailyReportPreview,

    // ── PHASE_5_HEALTH_OBSERVABILITY_2026-05 ──
    healthPreview,

    // ── PHASE_B_MANIPULATION_INTEGRATION — gate-impact telemetry ──
    manipulationGateImpact: manipulationRiskMap ? {
      blockedFromApproval:   manipulationBlockedRows.length,
      riskRestrictedCount:   manipulationRiskRestrictedRows.length,
      penalizedCount:        manipulationPenalizedCount,
      warningOnlyCount:      manipulationWarningCount,
      blockedSymbols:        manipulationBlockedRows
        .map((r) => String(r.symbol ?? r.tradingsymbol ?? ''))
        .filter(Boolean),
      riskRestrictedSymbols: manipulationRiskRestrictedRows
        .map((r) => String(r.symbol ?? r.tradingsymbol ?? ''))
        .filter(Boolean),
      // active=true only when the gate had a chance to demote (fresh
      // data + a non-empty approved set). Stale/no-data caps every
      // recommendedAction at WARNING_ONLY which never enters the
      // demotion loop, so `active` truthfully reports "the gate ran".
      active:                manipulationBlockedRows.length > 0 || manipulationRiskRestrictedRows.length > 0
                             || manipulationPenalizedCount > 0 || manipulationWarningCount > 0,
      dataStatus:            (() => {
        for (const risk of manipulationRiskMap.values()) {
          return risk.freshnessStatus;
        }
        return 'NO_DATA' as const;
      })(),
    } : undefined,
  };
}

// Re-export for callers that want to use these helpers directly.
export {
  rankSignalsByInstitutionalScore,
  calculateApprovalGap,
  buildMissingApprovalFactors,
  buildClosestToApprovalSignals,
};
