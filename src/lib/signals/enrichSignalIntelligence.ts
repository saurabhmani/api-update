// ════════════════════════════════════════════════════════════════
//  enrichSignalIntelligence — Phase 3 + 5 + 6 bulk integration
//
//  Phase 1–2 already enriched per-row metadata via compactConfirmedSignal.
//  This module adds the missing intelligence layers — regime routing
//  (Phase 3), confirmation aggregate (Phase 5), conflict resolution
//  (Phase 6) — to every row returned by /api/signals?action=all etc.,
//  in a shape that's additive (existing fields untouched).
//
//  Performance contract:
//   - Heavy lookups (benchmark candles, routing matrix, batch-loaded
//     manipulation snapshots) happen ONCE per request in
//     `loadIntelligenceContext()`. The per-row enrichment is pure.
//   - Routing decisions are pre-computed for every registered
//     strategy and looked up by strategyId in O(1).
//   - Confirmation aggregate runs per row but each module is a pure
//     function over fields already in scope. No per-row DB calls.
//
//  Safety contract:
//   - Never raises. Missing benchmark → regimeStatus 'INSUFFICIENT_DATA',
//     every strategy → WATCHLIST_ONLY routing.
//   - Never promotes a row. Enrichment is observation-only — the
//     existing approval / classification on the row is preserved.
//   - Never invents data. Modules without inputs return UNAVAILABLE /
//     INSUFFICIENT_DATA cleanly.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { detectMarketRegime, detectEnhancedRegime } from '@/lib/signal-engine/regime/detectMarketRegime';
import type { Candle, MarketRegimeLabel, StrategyName } from '@/lib/signal-engine/types/signalEngine.types';
import { getSector } from '@/lib/signal-engine/constants/phase3.constants';
import { STRATEGY_REGISTRY, getStrategyMeta } from '@/lib/signal-engine/strategies/strategyRegistry';
import {
  buildRegimeRouter,
  routeStrategy,
  type StrategyRoutingDecision,
  type RoutedRegime,
  type RegimeStatus,
} from '@/lib/strategies/regimeRouter';
import {
  aggregateConfirmation,
  buildSectorConfirmation,
  buildOptionsConfirmation,
  buildNewsConfirmation,
  buildManipulationConfirmation,
  buildExecutionConfirmation,
  type ConfirmationAggregate,
  type ApprovalRecommendation,
  type ModuleStatus,
} from '@/lib/confirmation/confirmationAggregator';
import {
  resolveConflicts,
  type ConflictResolution,
  type ConflictStatus,
} from '@/lib/strategies/conflictResolver';
import type { ManipulationRisk } from '@/lib/manipulation-engine/manipulationSignalRisk';
import {
  normalizeSignalReasons,
  type NormalizedSignalReasons,
} from '@/lib/signals/normalizeReasons';
import {
  loadOptionsSnapshotsByBatch,
  type PersistedOptionsSnapshot,
} from '@/lib/strategies/writers/optionsSnapshotWriter';
import {
  applyInstitutionalDecisionGate,
  type FinalDecision,
  type RawAction,
} from '@/lib/signals/finalDecisionGate';

// ── Public types ──────────────────────────────────────────────

export interface IntelligenceContext {
  /** Wire-friendly regime label (snake_case). */
  currentRegime:        RoutedRegime;
  /** Detector-vs-stale-detection outcome. */
  regimeStatus:         RegimeStatus;
  /** Pre-computed per-strategy routing decisions, keyed by strategyId. */
  routingByStrategy:    Map<string, StrategyRoutingDecision>;
  /** Pre-loaded manipulation risk by symbol, when the surveillance
   *  table has rows. Empty Map when the table is missing on this DB. */
  manipulationBySymbol: Map<string, ManipulationRisk>;
  /** Phase-5 hardening — sector trend derived from the live signal
   *  pool (cross-sectional buy/sell mix per sector). When set, the
   *  sector confirmation module uses real Strong/Positive/Weak/
   *  Declining labels instead of always 'Neutral'. */
  sectorTrendBySector?: Map<string, { trend: 'Strong' | 'Positive' | 'Neutral' | 'Weak' | 'Declining'; score: number; sampleSize: number }>;
  /** Phase-5 bulk-options — per-symbol options snapshot pre-loaded
   *  from `q365_options_snapshots`. When set, the options
   *  confirmation module emits real PCR/bias/IV instead of always
   *  UNAVAILABLE on the bulk path. */
  optionsBySymbol?:    Map<string, PersistedOptionsSnapshot>;
  /** Diagnostics — surfaced under `intelligenceContext` on the wire
   *  so the dashboard can show "regime stale" / "no manipulation
   *  snapshot found" without re-querying. */
  diagnostics: {
    benchmarkBars:              number;
    benchmarkAgeMinutes:        number | null;
    manipulationRowsLoaded:     number;
    strategyRoutingsComputed:   number;
    sectorsWithTrend?:          number;
  };
}

export interface IntelligenceEnrichment {
  // ── Phase 3 — regime + routing ─────────────────────────────
  currentRegime:                    RoutedRegime;
  regimeStatus:                     RegimeStatus;
  strategyRoutingDecision:          StrategyRoutingDecision['routingDecision'];
  routingConfidenceAdjustment:      number;
  routingApprovalThresholdAdjustment: number;
  routingPositionSizeAdjustment:    number;
  routingReason:                    string;
  routingWarnings:                  string[];

  // ── Phase 5 — confirmation aggregate ───────────────────────
  confirmationScore:                number;
  confirmationStatus:               ApprovalRecommendation;
  confirmationBoosters:             string[];
  confirmationBlockers:             string[];
  confirmationNeutralFactors:       string[];
  confirmationWarnings:             string[];
  confirmationModulesAvailable:     number;
  sectorConfirmation:               ModuleStatus;
  optionsConfirmation:              ModuleStatus;
  newsConfirmation:                 ModuleStatus;
  manipulationRiskConfirmation:     ModuleStatus;
  executionQuality:                 ModuleStatus;

  // ── Phase 6 — conflict resolution ──────────────────────────
  conflictStatus:                   ConflictStatus;
  conflictingStrategies:            string[];
  conflictDominantView:             ConflictResolution['dominantView'];
  conflictDecisionImpact:           string;
  conflictExplanation:              string;
  conflictRecommendation:           ConflictResolution['recommendation'];

  // ── Phase 1 — normalized reason buckets ────────────────────
  normalizedReasons:                NormalizedSignalReasons;

  // ── Phase 3 + 5 + 6 — institutional final decision gate ───
  // Raw vs effective approval so the operator sees both the
  // upstream DB classification AND the post-intelligence verdict
  // without losing either. Demotion-only — never promotes.
  rawApprovalStatus:                RawAction;
  effectiveApprovalStatus:          RawAction;
  rawAction:                        RawAction;
  effectiveAction:                  RawAction;
  decisionChanged:                  boolean;
  demotionReason:                   string | null;
  institutionalBlockers:            string[];
  institutionalWarnings:            string[];
  decisionTrace:                    FinalDecision['decisionTrace'];
}

/** Minimal row shape this enricher reads from. Compact OR full rows
 *  satisfy it because every field is optional. */
export interface EnrichableRow {
  symbol?:           string | null;
  tradingsymbol?:    string | null;
  direction?:        string | null;
  signal_type?:      string | null;
  strategy?:         string | null;
  strategyId?:       string | null;
  confidence_score?: number | null;
  confidence?:       number | null;
  entry_price?:      number | string | null;
  stop_loss?:        number | string | null;
  risk_reward?:      number | null;
  rr_ratio?:         number | null;
  signal_status?:    string | null;
  classification?:   string | null;
  sector?:           string | null;
  manipulationRisk?: ManipulationRisk | null;
  // Reason fields (any of these may be present on different code paths)
  rejection_reason?:        unknown;
  rejection_reasons?:       unknown;
  rejection_reasons_json?:  unknown;
  watchlistReasons?:        unknown;
  confirmationReasons?:     unknown;
  missingApprovalFactors?:  unknown;
}

// ── Shared-context loader ─────────────────────────────────────

const STALE_MIN = 36 * 60;
const BENCHMARK_INSTRUMENT_KEY = 'NSE_INDEX|NIFTY 50';

/**
 * Load the intelligence context ONCE per /api/signals request and
 * thread it through the per-row enricher.
 *
 * Pass the symbols you'll be enriching so the manipulation snapshot
 * load can be batched. Pass an empty array if symbols aren't yet known
 * — manipulation lookups will then fall back to per-row UNAVAILABLE.
 */
export async function loadIntelligenceContext(
  symbols: string[],
): Promise<IntelligenceContext> {
  const [candles, manipulationBySymbol, optionsBySymbol] = await Promise.all([
    loadBenchmarkCandles(),
    loadManipulationBatch(symbols),
    loadOptionsSnapshotsByBatch(symbols),
  ]);

  // ── Regime detection. ──
  let detectedLabel: MarketRegimeLabel | null = null;
  let regimeStrength: number | null = null;
  let benchmarkAgeMinutes: number | null = null;
  if (candles.length >= 30) {
    try {
      const enhanced = detectEnhancedRegime(candles);
      detectedLabel  = enhanced.label;
      regimeStrength = enhanced.confidence;
    } catch {
      detectedLabel = null;
    }
    benchmarkAgeMinutes = ageMinutesFrom(candles[candles.length - 1].ts);
  }
  const staleDataFlag =
    candles.length === 0 ||
    detectedLabel === null ||
    (typeof benchmarkAgeMinutes === 'number' && benchmarkAgeMinutes > STALE_MIN);

  const router = buildRegimeRouter({
    detectedRegime:     detectedLabel,
    regimeStrength,
    benchmarkAgeMinutes,
    performances:       [],          // bulk enricher doesn't apply perf tilt here
    performanceWindow:  null,
    staleDataFlag,
  });

  // Pre-compute routing for every registered strategy so per-row
  // lookups are O(1). The full registry has 21 entries, so this is
  // a fixed cost regardless of how many signals the response carries.
  const routingByStrategy = new Map<string, StrategyRoutingDecision>();
  for (const strategyId of Object.keys(STRATEGY_REGISTRY)) {
    routingByStrategy.set(strategyId, routeStrategy({
      strategyId,
      regime:       router.currentRegime,
      regimeStatus: router.regimeStatus,
    }));
  }

  return {
    currentRegime:        router.currentRegime,
    regimeStatus:         router.regimeStatus,
    routingByStrategy,
    manipulationBySymbol,
    optionsBySymbol,
    diagnostics: {
      benchmarkBars:            candles.length,
      benchmarkAgeMinutes,
      manipulationRowsLoaded:   manipulationBySymbol.size,
      strategyRoutingsComputed: routingByStrategy.size,
    },
  };
}

async function loadBenchmarkCandles(): Promise<Candle[]> {
  try {
    const { rows } = await db.query<any>(
      `SELECT ts, open, high, low, close, volume
         FROM candles
        WHERE instrument_key = ? AND candle_type='eod' AND interval_unit='1day'
        ORDER BY ts DESC LIMIT 260`,
      [BENCHMARK_INSTRUMENT_KEY],
    );
    return (rows ?? []).map((r) => ({
      ts:     typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString().split('T')[0],
      open:   Number(r.open), high: Number(r.high), low: Number(r.low),
      close:  Number(r.close), volume: Number(r.volume),
    })).reverse();
  } catch { return []; }
}

async function loadManipulationBatch(symbols: string[]): Promise<Map<string, ManipulationRisk>> {
  const out = new Map<string, ManipulationRisk>();
  if (symbols.length === 0) return out;
  // De-dup + safety cap.
  const uniq = Array.from(new Set(symbols.filter((s): s is string => typeof s === 'string' && !!s))).slice(0, 2000);
  if (uniq.length === 0) return out;
  try {
    const placeholders = uniq.map(() => '?').join(',');
    const { rows } = await db.query<any>(
      `SELECT s.symbol, s.suspicion_band AS band, s.suspicion_score AS score,
              s.snapshot_date AS latestEventDate
         FROM q365_manipulation_snapshots s
         JOIN (
                SELECT symbol, MAX(snapshot_date) AS d
                  FROM q365_manipulation_snapshots
                 WHERE symbol IN (${placeholders})
                 GROUP BY symbol
              ) latest
           ON latest.symbol = s.symbol AND latest.d = s.snapshot_date`,
      uniq,
    );
    for (const r of rows ?? []) {
      const sym = String(r.symbol ?? '');
      if (!sym || !r.band) continue;
      // The confirmation module only reads `band` and `score`. We
      // construct a minimal envelope and cast through `unknown` so
      // we don't have to fabricate the other ManipulationRisk fields
      // (latestScanAt, alertCount, etc.) that aren't relevant here.
      out.set(sym, ({
        symbol:            sym,
        band:              String(r.band).toUpperCase(),
        score:             Number(r.score ?? 0),
        latestEventDate:   r.latestEventDate ? String(r.latestEventDate).slice(0, 10) : null,
        freshnessStatus:   'FRESH',
        canAffectApproval: true,
        recommendedAction: 'WARNING_ONLY',
      } as unknown) as ManipulationRisk);
    }
  } catch {
    // Table not present — empty map is the correct soft-fail.
  }
  return out;
}

function ageMinutesFrom(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60_000));
}

// ── Per-row enricher ──────────────────────────────────────────

/** Resolve the strategyId from any of the row shapes the platform uses. */
function resolveStrategyId(row: EnrichableRow): string {
  return (row.strategyId ?? row.signal_type ?? row.strategy ?? 'unclassified') as string;
}

/**
 * Optional sibling-candidate map. When provided, the conflict
 * resolver sees every other candidate that fired on the same symbol
 * (across all tiers in the same response) instead of just the row's
 * own strategy. This is how the new institutional resolver picks up
 * BUY-vs-SELL conflicts from the multi-strategy bulk view.
 */
export interface SiblingCandidate {
  strategyId:      string;
  direction:       'BUY' | 'SELL';
  confidenceScore: number | null;
}
export type SiblingCandidateMap = Map<string, SiblingCandidate[]>;

/**
 * Phase-5 sector-trend builder.
 *
 * Reads the cross-sectional buy/sell mix per sector from the live
 * signal pool and tags each sector with a Strong/Positive/Neutral/
 * Weak/Declining label. This replaces the previous always-Neutral
 * fallback in the sector confirmation module — when we have rows in
 * a sector, the trend reflects reality.
 *
 * Thresholds:
 *   buyShare ≥ 0.70 → 'Strong'
 *   buyShare ≥ 0.55 → 'Positive'
 *   buyShare ≤ 0.30 → 'Declining'
 *   buyShare ≤ 0.45 → 'Weak'
 *   else            → 'Neutral'
 *
 * Sectors with fewer than 3 rows are not classified (they keep the
 * neutral baseline so a single signal can't anchor a "Strong" label).
 */
export function buildSectorTrendMap(
  rows: readonly EnrichableRow[],
): Map<string, { trend: 'Strong' | 'Positive' | 'Neutral' | 'Weak' | 'Declining'; score: number; sampleSize: number }> {
  const bucket = new Map<string, { buy: number; sell: number }>();
  for (const r of rows) {
    const sector = (r.sector ?? safeSector(String(r.symbol ?? '') )) as string | null;
    if (!sector) continue;
    const dir = String(r.direction ?? '').toUpperCase() === 'SELL' ? 'sell' : 'buy';
    const cell = bucket.get(sector) ?? { buy: 0, sell: 0 };
    if (dir === 'buy') cell.buy += 1; else cell.sell += 1;
    bucket.set(sector, cell);
  }
  const out = new Map<string, { trend: 'Strong' | 'Positive' | 'Neutral' | 'Weak' | 'Declining'; score: number; sampleSize: number }>();
  for (const [sector, cell] of bucket.entries()) {
    const total = cell.buy + cell.sell;
    if (total < 3) continue;            // too thin to classify honestly
    const buyShare = cell.buy / total;
    const trend: 'Strong' | 'Positive' | 'Neutral' | 'Weak' | 'Declining' =
      buyShare >= 0.70 ? 'Strong'
      : buyShare >= 0.55 ? 'Positive'
      : buyShare <= 0.30 ? 'Declining'
      : buyShare <= 0.45 ? 'Weak'
      :                    'Neutral';
    // 0..100 score — 100 = pure buy, 0 = pure sell, 50 = balanced.
    const score = Math.round(buyShare * 100);
    out.set(sector, { trend, score, sampleSize: total });
  }
  return out;
}

/** Build a sibling map from a flat list of rows — typically the
 *  concatenation of all tiers in the current response. */
export function buildSiblingCandidateMap(rows: readonly EnrichableRow[]): SiblingCandidateMap {
  const out: SiblingCandidateMap = new Map();
  for (const r of rows) {
    const sym = String(r.symbol ?? r.tradingsymbol ?? '');
    if (!sym) continue;
    const sid = resolveStrategyId(r);
    const dir: 'BUY' | 'SELL' = String(r.direction ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
    const conf = typeof r.confidence_score === 'number' ? r.confidence_score
               : typeof r.confidence       === 'number' ? r.confidence
               :                                          null;
    const list = out.get(sym) ?? [];
    // De-dup by (strategy, direction) so the same row appearing in
    // multiple tiers (e.g. high_potential + watchlist mirrors) doesn't
    // inflate the conflict count.
    if (!list.some((c) => c.strategyId === sid && c.direction === dir)) {
      list.push({ strategyId: sid, direction: dir, confidenceScore: conf });
    }
    out.set(sym, list);
  }
  return out;
}

/** Compute the per-row intelligence enrichment. Pure — no I/O. */
export function enrichSignalRow(
  row: EnrichableRow,
  ctx: IntelligenceContext,
  siblings?: SiblingCandidateMap,
): IntelligenceEnrichment {
  const strategyId = resolveStrategyId(row);
  const meta = getStrategyMeta(strategyId);
  const symbol = String(row.symbol ?? row.tradingsymbol ?? '');
  const direction: 'BUY' | 'SELL' =
    String(row.direction ?? '').toUpperCase() === 'SELL' ? 'SELL' : 'BUY';

  // ── Routing (already pre-computed) ──
  const routing = ctx.routingByStrategy.get(strategyId) ?? routeStrategy({
    strategyId, regime: ctx.currentRegime, regimeStatus: ctx.regimeStatus,
  });

  // ── Approval status (the row already finalised this — we read it). ──
  const currentAction: 'APPROVED' | 'WATCHLIST' | 'REJECTED' | null =
    row.signal_status === 'APPROVED_SIGNAL' ? 'APPROVED'
    : row.signal_status === 'DEVELOPING_SETUP' ? 'WATCHLIST'
    : row.signal_status === 'NO_TRADE' ? 'REJECTED'
    : (row.classification && String(row.classification).toUpperCase() === 'CONFIRMED') ? 'APPROVED'
    : (row.classification && String(row.classification).toUpperCase() === 'DEVELOPING') ? 'WATCHLIST'
    : null;

  // ── Confirmation modules. ──
  const manipulationRisk = ctx.manipulationBySymbol.get(symbol) ?? (row.manipulationRisk ?? null);
  const sectorName = row.sector ?? safeSector(symbol);
  const entry = Number(row.entry_price ?? 0);
  const stop  = Number(row.stop_loss  ?? 0);
  const stopDistancePct = entry > 0 && stop > 0
    ? Math.abs((entry - stop) / entry) * 100
    : null;
  const riskReward = typeof row.risk_reward === 'number' ? row.risk_reward
    : typeof row.rr_ratio === 'number' ? row.rr_ratio
    : null;

  const confirmation = aggregateConfirmation({
    signalId:      null,
    symbol,
    strategyId:    meta.strategyId,
    direction,
    currentAction,
    modules: {
      sector: (() => {
        // Phase-5 hardening: when we have a cross-sectional sector
        // trend (derived from the live signal pool), use it. Falls
        // back to a transparent Neutral/50 baseline only when the
        // sector has fewer than 3 rows in the response.
        const live = sectorName && ctx.sectorTrendBySector
          ? ctx.sectorTrendBySector.get(sectorName)
          : undefined;
        return buildSectorConfirmation({
          sector:           sectorName,
          sectorScore:      live ? live.score : (sectorName ? 50 : null),
          sectorTrend:      live ? live.trend : (sectorName ? 'Neutral' : null),
          relativeStrength: null,
          direction,
        });
      })(),
      options: (() => {
        // Phase-5 closure: when a fresh options snapshot exists for
        // this symbol in q365_options_snapshots, use it. Otherwise
        // honest UNAVAILABLE — never synthetic.
        const snap = ctx.optionsBySymbol?.get(symbol) ?? null;
        if (!snap) {
          return buildOptionsConfirmation({
            available:     false,
            source:        'unavailable',
            optionsBias:   null,
            pcr:           null,
            ivState:       null,
            keySupport:    null,
            keyResistance: null,
            direction,
          });
        }
        return buildOptionsConfirmation({
          available:     true,
          source:        snap.source,
          optionsBias:   snap.bias,
          pcr:           snap.pcr,
          ivState:       snap.ivState,
          keySupport:    snap.keySupport,
          keyResistance: snap.keyResistance,
          direction,
        });
      })(),
      news: buildNewsConfirmation({
        available:     false,
        sentiment:     null,
        catalystType:  null,
        impactScore:   null,
        freshness:     null,
        direction,
        highEventRisk: false,
      }),
      manipulation: buildManipulationConfirmation({
        available: !!manipulationRisk,
        risk:      manipulationRisk,
      }),
      execution: buildExecutionConfirmation({
        liquidityScore:      null,
        spreadBps:           null,
        stopDistancePct,
        riskReward,
        avgVolume:           null,
        slippageEstimateBps: null,
      }),
    },
  });

  // ── Conflict resolver. When siblings are provided, we pass the
  //    full set so BUY-vs-SELL conflicts on the same symbol surface
  //    correctly. Without siblings we fall back to a single-candidate
  //    view that always reports conflictStatus: 'NONE'. ──
  const candidates = (siblings?.get(symbol) ?? [{
    strategyId,
    direction,
    confidenceScore: typeof row.confidence_score === 'number' ? row.confidence_score
                     : typeof row.confidence       === 'number' ? row.confidence
                     : null,
  }]);
  const conflict = resolveConflicts({
    symbol,
    candidates,
    manipulationRiskBand: confirmation.modules.manipulation.riskBand ?? null,
    marketRegime:         ctx.currentRegime,
  });

  // ── Normalized reason buckets. ──
  const normalizedReasons = normalizeSignalReasons({
    confirmationReasons:    confirmation.boosters,
    watchlistReasons:       confirmation.blockers,
    rejectionReasons:       toArray(row.rejection_reasons_json) ?? toArray(row.rejection_reasons),
    missingApprovalFactors: row.missingApprovalFactors,
    reason:                 row.rejection_reason,
  });

  // ── Institutional final decision gate (Phase 3 + 5 + 6) ──
  // Layers regime + confirmation + conflict + manipulation +
  // execution over the row's raw status. Demotion-only — never
  // promotes through hard blockers. The raw status is preserved
  // intact; the gate emits parallel effective fields.
  const rawAction: RawAction =
    currentAction === 'APPROVED'  ? 'APPROVED'
    : currentAction === 'WATCHLIST' ? 'WATCHLIST'
    : currentAction === 'REJECTED'  ? 'REJECTED'
    :                                  'WATCHLIST';
  const freshnessState = String(
    (row as { freshness_state?: unknown; decay_state?: unknown }).freshness_state ??
    (row as { decay_state?: unknown }).decay_state ?? '',
  );
  const isStaleData = /stale|expired/i.test(freshnessState);
  const stopDistanceInvalid = entry > 0 && stop > 0 ? false
    : (currentAction === 'APPROVED' && entry > 0 && stop <= 0);

  const decision = applyInstitutionalDecisionGate({
    rawAction,
    freshnessState: freshnessState || null,
    isStaleData,
    routing,
    currentRegime:       ctx.currentRegime,
    confirmation,
    executionStatus:     confirmation.modules.execution.status,
    manipulationStatus:  confirmation.modules.manipulation.status,
    manipulationBand:    confirmation.modules.manipulation.riskBand ?? null,
    conflict,
    riskRewardInvalid:   stopDistanceInvalid,
  });

  return {
    currentRegime:                       ctx.currentRegime,
    regimeStatus:                        ctx.regimeStatus,
    strategyRoutingDecision:             routing.routingDecision,
    routingConfidenceAdjustment:         routing.confidenceAdjustment,
    routingApprovalThresholdAdjustment:  routing.approvalThresholdAdjustment,
    routingPositionSizeAdjustment:       routing.positionSizeAdjustment,
    routingReason:                       routing.reason,
    routingWarnings:                     routing.warnings,
    confirmationScore:                   confirmation.confirmationScore,
    confirmationStatus:                  confirmation.approvalRecommendation,
    confirmationBoosters:                confirmation.boosters,
    confirmationBlockers:                confirmation.blockers,
    confirmationNeutralFactors:          confirmation.neutralFactors,
    confirmationWarnings:                confirmation.dataQuality.warnings,
    confirmationModulesAvailable:        confirmation.dataQuality.modulesAvailable,
    sectorConfirmation:                  confirmation.modules.sector.status,
    optionsConfirmation:                 confirmation.modules.options.status,
    newsConfirmation:                    confirmation.modules.news.status,
    manipulationRiskConfirmation:        confirmation.modules.manipulation.status,
    executionQuality:                    confirmation.modules.execution.status,
    conflictStatus:                      conflict.conflictStatus,
    conflictingStrategies:               conflict.conflictingStrategies,
    conflictDominantView:                conflict.dominantView,
    conflictDecisionImpact:              conflict.decisionImpact,
    conflictExplanation:                 conflict.explanation,
    conflictRecommendation:              conflict.recommendation,
    normalizedReasons,
    // Final decision gate — Phase 3 + 5 + 6.
    rawApprovalStatus:                   decision.rawApprovalStatus,
    effectiveApprovalStatus:             decision.effectiveApprovalStatus,
    rawAction:                           decision.rawAction,
    effectiveAction:                     decision.effectiveAction,
    decisionChanged:                     decision.decisionChanged,
    demotionReason:                      decision.demotionReason,
    institutionalBlockers:               decision.institutionalBlockers,
    institutionalWarnings:               decision.institutionalWarnings,
    decisionTrace:                       decision.decisionTrace,
  };
}

/**
 * Bulk helper — applies enrichment per row. Pass `siblings` to give
 * the conflict resolver visibility across rows in the same response
 * (computed via `buildSiblingCandidateMap()`).
 */
export function enrichSignalRows<T extends EnrichableRow>(
  rows: readonly T[],
  ctx: IntelligenceContext,
  siblings?: SiblingCandidateMap,
): Array<T & IntelligenceEnrichment> {
  return rows.map((r) =>
    Object.assign({}, r, enrichSignalRow(r, ctx, siblings)) as T & IntelligenceEnrichment,
  );
}

// ── Utilities ─────────────────────────────────────────────────

function safeSector(symbol: string): string | null {
  if (!symbol) return null;
  try {
    const s = getSector(symbol);
    return s && s !== 'Other' ? s : null;
  } catch { return null; }
}

function toArray(v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') {
    // JSON-encoded array? Best-effort parse.
    try {
      const parsed = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string');
    } catch { /* fall through */ }
    return [v];
  }
  return undefined;
}

// Re-export StrategyName for callers that need to type-check downstream.
export type { StrategyName };
