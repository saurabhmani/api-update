// ════════════════════════════════════════════════════════════════
//  dailySignalReport — PHASE_3_DAILY_INTELLIGENCE_2026-05
//
//  Pure builder for the Daily Signal Intelligence Report. Consumes
//  the same signal pools and due-diligence context that powers the
//  live Signal Engine page; produces a single structured report
//  object the new daily-report page renders.
//
//  CRITICAL SAFETY RULES:
//   - This module NEVER alters approval thresholds.
//   - This module NEVER updates scoring weights.
//   - This module NEVER fabricates price outcomes, market movers,
//     sector strength, or indicator win-rates.
//   - When the platform does not persist a data source the report
//     needs (per-signal price history, market mover list, sector
//     join, intra-day outcome timestamps), the corresponding section
//     is marked INSUFFICIENT_DATA / PARTIAL with explicit reasons.
//   - Learning recommendations are governance-flagged as
//     REVIEW_REQUIRED / DO_NOT_APPLY_AUTOMATICALLY.
//
//  Pure module — no I/O, no DB, no env reads. Same input → same
//  output. Same factor data, same report.
// ════════════════════════════════════════════════════════════════

import {
  rankSignalsByInstitutionalScore,
  getSignalFinalScore,
  getSignalConfidence,
  getSignalRiskReward,
  APPROVAL_TARGET_FINAL_SCORE,
  APPROVAL_TARGET_CONFIDENCE,
  APPROVAL_TARGET_RISK_REWARD,
  type RankableSignal,
} from '@/lib/signals/signalRanking';
import { summarizeManipulationImpact as summarizeManipulationImpactSync } from '@/lib/manipulation-engine/manipulationSignalRisk';
import type {
  DueDiligenceSummary,
} from '@/lib/signals/signalDueDiligence';

// ── Public contract ─────────────────────────────────────────────

export type DailyReportDataStatus =
  | 'LIVE'
  | 'STALE'
  | 'FALLBACK'
  | 'BOOTSTRAP'
  | 'INSUFFICIENT_DATA';

export type DailyReportStatus =
  | 'COMPLETE'
  | 'PARTIAL'
  | 'PENDING'
  | 'INSUFFICIENT_DATA';

export interface DailyExecutiveSummary {
  headline:       string;
  summary:        string;
  keyTakeaways:   string[];
  riskWarnings:   string[];
  tomorrowFocus:  string[];
}

export interface DailySignalPerformance {
  approvedTotal:                  number;
  approvedSuccess:                number | null;
  approvedFailed:                 number | null;
  approvedPending:                number | null;
  approvedWinRate:                number | null;

  highPotentialTotal:             number;
  highPotentialPerformed:         number | null;
  highPotentialMissedApproval:    number;

  watchlistTotal:                 number;
  watchlistPerformed:             number | null;

  rejectedTotal:                  number;
  rejectedPerformed:              number | null;
  rejectionFalseNegativeRate:     number | null;

  /** Reasons we could not populate a counter (eg "per-signal price
   *  history not persisted"). Lets the UI render an honest
   *  "INSUFFICIENT_DATA" badge instead of zeros. */
  insufficientDataReasons:        string[];
}

export interface IndicatorPerformanceItem {
  indicator:        string;
  totalSignals:     number;
  /** Outcome counts — null when outcome data unavailable. */
  successCount:     number | null;
  failedCount:      number | null;
  pendingCount:     number | null;
  winRate:          number | null;
  avgMovePercent:   number | null;
  /** Coverage metric — the percent of signals where this factor was
   *  populated AND ≥ STRONG threshold. Computed from real
   *  factor_scores rather than outcome data. */
  strongCoverage:   number | null;
  notes:            string;
}

export interface IndicatorCombinationPerformance {
  combination:    string;
  totalSignals:   number;
  successCount:   number | null;
  failedCount:    number | null;
  winRate:        number | null;
  notes:          string;
}

export interface DailyIndicatorPerformance {
  bestIndicators:        IndicatorPerformanceItem[];
  weakIndicators:        IndicatorPerformanceItem[];
  neutralIndicators:     IndicatorPerformanceItem[];
  indicatorCombinations: IndicatorCombinationPerformance[];
  status:                'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
  notes:                 string[];
}

export interface MissedOpportunityItem {
  symbol:              string;
  movePercent:         number | null;
  direction:           'UP' | 'DOWN' | null;
  wasSignalGenerated:  boolean;
  highestTierReached:  'NONE' | 'WATCHLIST' | 'HIGH_POTENTIAL' | 'REJECTED' | 'APPROVED';
  reasonMissed:        string;
  failedConditions:    string[];
  suggestedReview:     string;
  learningPriority:    'LOW' | 'MEDIUM' | 'HIGH';
}

export interface SectorPerformanceItem {
  sector:           string;
  totalSignals:     number;
  approvedCount:    number;
  performingCount:  number | null;
  winRate:          number | null;
  notes:            string;
}

export interface DailySectorPerformance {
  bestSectors:    SectorPerformanceItem[];
  weakSectors:    SectorPerformanceItem[];
  status:         'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
  notes:          string[];
}

export interface TimeWindowPerformanceItem {
  window:           '09:15-10:30' | '10:30-12:00' | '12:00-13:30' | '13:30-15:30' | string;
  totalSignals:     number;
  approvedCount:    number;
  performingCount:  number | null;
  winRate:          number | null;
  notes:            string;
}

export interface DailyTimeWindowPerformance {
  bestTimeWindows:  TimeWindowPerformanceItem[];
  weakTimeWindows:  TimeWindowPerformanceItem[];
  status:           'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
  notes:            string[];
}

export interface MarketRegimeReview {
  detectedRegime:           string;
  regimeConfidence:         number | null;
  bestStrategyForRegime:    string | null;
  weakStrategyForRegime:    string | null;
  notes:                    string[];
}

export interface BlockReasonItem {
  reason:       string;
  count:        number;
  impact:       'LOW' | 'MEDIUM' | 'HIGH';
  explanation:  string;
}

export interface LearningRecommendationItem {
  title:              string;
  observation:        string;
  evidence:           string;
  suggestedAction:    string;
  governanceStatus:   'REVIEW_REQUIRED' | 'READY_FOR_ANALYST_REVIEW' | 'DO_NOT_APPLY_AUTOMATICALLY';
  priority:           'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
}

export interface DailyDataQuality {
  provider:           string | null;
  lastSuccessAt:      string | null;
  staleMinutes:       number | null;
  symbolsRequested:   number | null;
  symbolsReturned:    number | null;
  coveragePercent:    number | null;
  warnings:           string[];
}

export interface DailySignalReport {
  reportDate:               string;
  generatedAt:              string;
  marketStatus:             string;
  dataStatus:               DailyReportDataStatus;
  reportStatus:             DailyReportStatus;
  executiveSummary:         DailyExecutiveSummary;
  signalPerformance:        DailySignalPerformance;
  indicatorPerformance:     DailyIndicatorPerformance;
  missedOpportunities:      MissedOpportunityItem[];
  missedOpportunitiesStatus: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
  sectorPerformance:        DailySectorPerformance;
  timeWindowPerformance:    DailyTimeWindowPerformance;
  marketRegimeReview:       MarketRegimeReview;
  topBlockReasons:          BlockReasonItem[];
  learningRecommendations:  LearningRecommendationItem[];
  dataQuality:              DailyDataQuality;
  warnings:                 string[];
  /** PHASE_4_BACKTESTING_2026-05 — optional preview attached when
   *  the daily-report route resolved the backtest for the same date.
   *  Always optional so the daily report does not block on it. */
  backtestPreview?:         DailyReportBacktestPreview | null;
  /** PHASE_B_MANIPULATION — surveillance impact summary built from the
   *  manipulationRisk envelope attached to each signal. Always optional
   *  so the daily report degrades cleanly when the engine isn't wired. */
  manipulationFilterImpact?: import('@/lib/manipulation-engine/manipulationSignalRisk').ManipulationImpactSummary | null;
}

/** Mirrors BacktestPreview from dailyBacktestEngine, declared here so
 *  the daily report module doesn't import the backtest module
 *  (one-way dependency direction). */
export interface DailyReportBacktestPreview {
  status:                  'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA' | 'FAILED';
  window:                  'INTRADAY' | '1D' | '7D' | '30D' | '90D' | 'CUSTOM';
  totalTested:             number;
  winRate:                 number | null;
  approvedWinRate:         number | null;
  highPotentialWinRate:    number | null;
  topIndicator:            string | null;
  weakestIndicator:        string | null;
  dataSufficiency:         'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
  warnings:                string[];
}

export interface DailyReportInput {
  reportDate?:   string;
  marketStatus: {
    isOpen: boolean;
    label:  string;
    state?: string;
  };
  signals: {
    approved:           RankableSignal[];
    highPotential:      RankableSignal[];
    watchlist:          RankableSignal[];
    developing:         RankableSignal[];
    scannerCandidates:  RankableSignal[];
    riskRestricted:     RankableSignal[];
    rejected:           RankableSignal[];
    /** Raw decayed/scanned pool — drives the rejection histogram. */
    decayedPool?:       RankableSignal[];
  };
  dueDiligenceSummary?: DueDiligenceSummary | null;
  dataQuality: {
    provider:           string | null;
    lastSuccessAt:      string | null;
    staleMinutes:       number | null;
    symbolsRequested:   number | null;
    symbolsReturned:    number | null;
    coveragePercent:    number | null;
    isBootstrap:        boolean;
    isFallback:         boolean;
    freshnessLabel:     string | null;
  };
  /** Optional: when the caller has a market-movers feed it can pass
   *  it through. Without it, missedOpportunities is INSUFFICIENT_DATA. */
  marketMovers?: Array<{
    symbol:        string;
    movePercent:   number;
    direction:     'UP' | 'DOWN';
  }>;
}

// ── Internals ───────────────────────────────────────────────────

const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

const safePct = (a: number, b: number): number | null => {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return Math.round((a / b) * 1000) / 10;
};

const isStaleSignal = (s: RankableSignal): boolean => {
  const f = String(s.freshness_state ?? '').toUpperCase();
  const d = String(s.decay_state ?? '').toLowerCase();
  return f === 'STALE' || f === 'AGING' || d === 'stale' || d === 'aging';
};

const readFactorScores = (s: any): Record<string, number | null> => {
  const fs = s?.factor_scores;
  const out: Record<string, number | null> = {
    strategy_quality:    null,
    trend_alignment:     null,
    momentum:            null,
    volume_confirmation: null,
    risk_reward:         null,
    liquidity:           null,
    market_regime:       null,
    portfolio_fit:       null,
  };
  if (fs && typeof fs === 'object') {
    for (const k of Object.keys(out)) out[k] = numOrNull((fs as any)[k]);
  }
  out.portfolio_fit = out.portfolio_fit ?? numOrNull(s?.portfolio_fit_score);
  out.liquidity     = out.liquidity     ?? numOrNull(s?.liquidity_score);
  out.market_regime = out.market_regime ?? numOrNull(s?.market_regime_score);
  return out;
};

const STRONG_FACTOR_FLOOR = 70;

// Derive a positive/negative move % from entry → livePrice when both
// fields are present. Direction-aware: a SELL down 2% is "+2% in
// trade direction". Returns null when fields are missing.
const computeMoveInDirection = (s: any): number | null => {
  const entry   = numOrNull(s?.entry_price);
  const current = numOrNull(s?.livePrice ?? s?.ltp ?? s?.current_price);
  if (entry == null || current == null || entry <= 0) return null;
  const raw = ((current - entry) / entry) * 100;
  const dir = String(s?.direction ?? '').toUpperCase();
  return dir === 'SELL' ? -raw : raw;
};

// Classify the move into the outcome buckets the report uses.
type MoveOutcome = 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL' | 'UNKNOWN';
const classifyMove = (s: any): MoveOutcome => {
  const m = computeMoveInDirection(s);
  if (m == null) return 'UNKNOWN';
  if (m >= 0.5)  return 'POSITIVE';
  if (m <= -0.5) return 'NEGATIVE';
  return 'NEUTRAL';
};

// Sum-and-count helper for averaging move% across a tier.
const aggregateMove = (rows: readonly RankableSignal[]): {
  total: number;
  withData: number;
  positive: number;
  negative: number;
  neutral: number;
  avgMove: number | null;
} => {
  let positive = 0, negative = 0, neutral = 0, withData = 0;
  let moveSum = 0, moveCount = 0;
  for (const r of rows) {
    const m = computeMoveInDirection(r);
    if (m == null) continue;
    withData++;
    moveSum  += m;
    moveCount++;
    if (m >= 0.5)        positive++;
    else if (m <= -0.5)  negative++;
    else                 neutral++;
  }
  return {
    total:    rows.length,
    withData,
    positive,
    negative,
    neutral,
    avgMove:  moveCount > 0 ? Math.round((moveSum / moveCount) * 100) / 100 : null,
  };
};

// ── Signal performance ──────────────────────────────────────────

export function buildSignalPerformanceSummary(
  input: DailyReportInput,
): DailySignalPerformance {
  const reasons: string[] = [];
  const { approved, highPotential, watchlist, developing, scannerCandidates,
          riskRestricted, rejected } = input.signals;

  const approvedAgg = aggregateMove(approved);
  // Approved success/failed/pending — null when we have no rows with
  // outcome data so the UI doesn't paint zeros as real metrics.
  let approvedSuccess: number | null = null;
  let approvedFailed:  number | null = null;
  let approvedPending: number | null = null;
  if (approved.length === 0) {
    approvedSuccess = 0; approvedFailed = 0; approvedPending = 0;
  } else if (approvedAgg.withData === 0) {
    reasons.push('approved outcome data unavailable (no entry/live price pair)');
  } else {
    approvedSuccess = approvedAgg.positive;
    approvedFailed  = approvedAgg.negative;
    approvedPending = approved.length - approvedSuccess - approvedFailed;
  }
  const approvedWinRate = approvedSuccess != null && approved.length > 0
    ? safePct(approvedSuccess, approved.length)
    : null;

  // High-potential — count positive moves as "performed despite not
  // approved". Same null-when-no-outcome rule.
  const hpAgg = aggregateMove(highPotential);
  const highPotentialPerformed = hpAgg.withData > 0 ? hpAgg.positive : null;
  if (highPotential.length > 0 && hpAgg.withData === 0) {
    reasons.push('high_potential outcome data unavailable');
  }

  // Watchlist union = watchlist + developing + scannerCandidates
  // (mirrors how the page tabs read these).
  const watchPool = [...watchlist, ...developing, ...scannerCandidates];
  const wlAgg = aggregateMove(watchPool);
  const watchlistPerformed = wlAgg.withData > 0 ? wlAgg.positive : null;
  if (watchPool.length > 0 && wlAgg.withData === 0) {
    reasons.push('watchlist outcome data unavailable');
  }

  // Rejected — "false negatives" are rejected rows that nevertheless
  // moved positively in the implied direction. The display assembler
  // hands us this set as the soft-rejected pool; if direction is
  // unknown we exclude that row from the rate computation.
  const rejPool = [...rejected, ...riskRestricted];
  const rejAgg = aggregateMove(rejPool);
  const rejectedPerformed = rejAgg.withData > 0 ? rejAgg.positive : null;
  const rejectionFalseNegativeRate =
    rejectedPerformed != null && rejPool.length > 0
      ? safePct(rejectedPerformed, rejPool.length)
      : null;
  if (rejPool.length > 0 && rejAgg.withData === 0) {
    reasons.push('rejected outcome data unavailable');
  }

  // Persistent reasons section — note the systemic absence.
  reasons.push('per-signal price history not persisted yet (intraday MFE/MAE and time-to-target unavailable)');

  return {
    approvedTotal:               approved.length,
    approvedSuccess,
    approvedFailed,
    approvedPending,
    approvedWinRate,

    highPotentialTotal:          highPotential.length,
    highPotentialPerformed,
    highPotentialMissedApproval: highPotential.length, // every HP row missed the strict gate by definition

    watchlistTotal:              watchPool.length,
    watchlistPerformed,

    rejectedTotal:               rejPool.length,
    rejectedPerformed,
    rejectionFalseNegativeRate,

    insufficientDataReasons:     reasons,
  };
}

// ── Indicator performance ───────────────────────────────────────

const INDICATOR_LABELS: Record<string, string> = {
  trend_alignment:     'Trend Alignment',
  momentum:            'Momentum',
  volume_confirmation: 'Volume Confirmation',
  strategy_quality:    'Strategy Quality',
  market_regime:       'Market Regime',
  liquidity:           'Liquidity',
  portfolio_fit:       'Portfolio Fit',
  risk_reward:         'Risk-Reward Factor',
};

function buildIndicatorRow(
  factorKey: string,
  pool: readonly RankableSignal[],
): IndicatorPerformanceItem {
  const label = INDICATOR_LABELS[factorKey] ?? factorKey;
  let totalSignals = pool.length;
  let strongCount = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let pendingCount = 0;
  let moveSum = 0;
  let moveCount = 0;
  let outcomeWithStrong = 0;
  let strongPopulated = 0;

  for (const r of pool) {
    const factors = readFactorScores(r);
    const v = factors[factorKey];
    if (v == null) continue;
    strongPopulated++;
    if (v < STRONG_FACTOR_FLOOR) continue;
    strongCount++;
    const m = computeMoveInDirection(r);
    if (m == null) {
      pendingCount++;
      continue;
    }
    outcomeWithStrong++;
    moveSum += m;
    moveCount++;
    if (m >= 0.5)      positiveCount++;
    else if (m <= -0.5) negativeCount++;
  }

  const winRate = outcomeWithStrong > 0 ? safePct(positiveCount, outcomeWithStrong) : null;
  const avgMove = moveCount > 0 ? Math.round((moveSum / moveCount) * 100) / 100 : null;
  const strongCoverage = strongPopulated > 0 ? safePct(strongCount, strongPopulated) : null;

  let notes = '';
  if (winRate != null && winRate >= 60) {
    notes = `${label} signals moved in the trade direction on ${winRate}% of rows with outcome data.`;
  } else if (winRate != null && winRate >= 40) {
    notes = `${label} showed mixed outcomes (${winRate}% in-direction).`;
  } else if (winRate != null) {
    notes = `${label} underperformed today (${winRate}% in-direction).`;
  } else if (strongCoverage != null) {
    notes = `${label} appeared strong on ${strongCoverage}% of populated rows. Outcome data not yet available.`;
  } else {
    notes = `${label} factor not populated on today's signal pool.`;
  }

  return {
    indicator:        label,
    totalSignals,
    successCount:     outcomeWithStrong > 0 ? positiveCount : null,
    failedCount:      outcomeWithStrong > 0 ? negativeCount : null,
    pendingCount:     pendingCount > 0 ? pendingCount : null,
    winRate,
    avgMovePercent:   avgMove,
    strongCoverage,
    notes,
  };
}

export function buildIndicatorPerformance(
  input: DailyReportInput,
): DailyIndicatorPerformance {
  // Aggregate across every reviewed tier so the report reflects the
  // engine's day, not just a single bucket.
  const pool: RankableSignal[] = [
    ...input.signals.approved,
    ...input.signals.highPotential,
    ...input.signals.watchlist,
    ...input.signals.developing,
    ...input.signals.scannerCandidates,
    ...input.signals.riskRestricted,
    ...input.signals.rejected,
  ];

  const notes: string[] = [];

  if (pool.length === 0) {
    return {
      bestIndicators:        [],
      weakIndicators:        [],
      neutralIndicators:     [],
      indicatorCombinations: [],
      status:                'INSUFFICIENT_DATA',
      notes:                 ['No signals were reviewed today — indicator analysis unavailable.'],
    };
  }

  const rows = Object.keys(INDICATOR_LABELS).map((k) => buildIndicatorRow(k, pool));

  // Bucket by win-rate when outcome data exists, otherwise by
  // strongCoverage. Indicators with no data at all are neutral.
  const best:    IndicatorPerformanceItem[] = [];
  const weak:    IndicatorPerformanceItem[] = [];
  const neutral: IndicatorPerformanceItem[] = [];
  for (const r of rows) {
    if (r.winRate != null && r.winRate >= 60) best.push(r);
    else if (r.winRate != null && r.winRate < 40) weak.push(r);
    else if (r.strongCoverage != null && r.strongCoverage >= 60) best.push(r);
    else if (r.strongCoverage != null && r.strongCoverage < 40) weak.push(r);
    else neutral.push(r);
  }

  // Combinations — only meaningful when both component factors appear
  // STRONG together. Computed deterministically; no outcome inference
  // when we lack outcomes.
  const combos: IndicatorCombinationPerformance[] = [];
  const trackCombo = (label: string, keys: string[]) => {
    let total = 0;
    let outcome = 0;
    let positive = 0;
    for (const r of pool) {
      const f = readFactorScores(r);
      const allStrong = keys.every((k) => (f[k] ?? 0) >= STRONG_FACTOR_FLOOR);
      if (!allStrong) continue;
      total++;
      const m = computeMoveInDirection(r);
      if (m == null) continue;
      outcome++;
      if (m >= 0.5) positive++;
    }
    if (total === 0) return;
    const wr = outcome > 0 ? safePct(positive, outcome) : null;
    combos.push({
      combination:  label,
      totalSignals: total,
      successCount: outcome > 0 ? positive : null,
      failedCount:  outcome > 0 ? outcome - positive : null,
      winRate:      wr,
      notes:        wr != null
        ? `${label} combo moved in direction on ${wr}% of rows with outcome data.`
        : `${label} combo appeared on ${total} rows; outcome data unavailable.`,
    });
  };
  trackCombo('Trend + Momentum',       ['trend_alignment', 'momentum']);
  trackCombo('Trend + Volume',         ['trend_alignment', 'volume_confirmation']);
  trackCombo('Momentum + Volume',      ['momentum',        'volume_confirmation']);
  trackCombo('Trend + Regime',         ['trend_alignment', 'market_regime']);
  combos.sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

  const hasAnyOutcome = rows.some((r) => r.winRate != null);
  if (!hasAnyOutcome) {
    notes.push('Outcome data unavailable for today\'s rows — indicator scores reflect coverage, not win-rate.');
  }

  return {
    bestIndicators:        best,
    weakIndicators:        weak,
    neutralIndicators:     neutral,
    indicatorCombinations: combos,
    status:                hasAnyOutcome ? 'PARTIAL' : 'INSUFFICIENT_DATA',
    notes,
  };
}

// ── Missed opportunities ───────────────────────────────────────

export function buildMissedOpportunities(
  input: DailyReportInput,
): { items: MissedOpportunityItem[]; status: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA' } {
  // Path A: external market-movers feed wired by caller.
  if (Array.isArray(input.marketMovers) && input.marketMovers.length > 0) {
    const items: MissedOpportunityItem[] = [];
    const symbolIndex = (rows: RankableSignal[]): Map<string, RankableSignal> => {
      const m = new Map<string, RankableSignal>();
      for (const r of rows) {
        const key = String(r.symbol ?? r.tradingsymbol ?? '').toUpperCase();
        if (key) m.set(key, r);
      }
      return m;
    };
    const approvedIx     = symbolIndex(input.signals.approved);
    const hpIx           = symbolIndex(input.signals.highPotential);
    const watchlistIx    = symbolIndex(input.signals.watchlist);
    const developingIx   = symbolIndex(input.signals.developing);
    const scannerIx      = symbolIndex(input.signals.scannerCandidates);
    const rejectedIx     = symbolIndex(input.signals.rejected);
    const riskRestrIx    = symbolIndex(input.signals.riskRestricted);

    for (const mv of input.marketMovers) {
      const sym = mv.symbol.toUpperCase();
      const tier: MissedOpportunityItem['highestTierReached'] =
        approvedIx.has(sym)                          ? 'APPROVED'
        : hpIx.has(sym)                              ? 'HIGH_POTENTIAL'
        : (watchlistIx.has(sym) || developingIx.has(sym) || scannerIx.has(sym)) ? 'WATCHLIST'
        : (rejectedIx.has(sym) || riskRestrIx.has(sym)) ? 'REJECTED'
        :                                              'NONE';
      // Only surface as "missed" if not already shipped as APPROVED.
      if (tier === 'APPROVED') continue;
      const candidate =
           hpIx.get(sym)         ?? watchlistIx.get(sym)
        ?? developingIx.get(sym) ?? scannerIx.get(sym)
        ?? rejectedIx.get(sym)   ?? riskRestrIx.get(sym)
        ?? null;
      let reasonMissed: string;
      let failedConditions: string[] = [];
      if (candidate) {
        const fs = getSignalFinalScore(candidate);
        const cs = getSignalConfidence(candidate);
        const rr = getSignalRiskReward(candidate);
        if (fs < APPROVAL_TARGET_FINAL_SCORE) failedConditions.push(`final ${fs.toFixed(1)} < ${APPROVAL_TARGET_FINAL_SCORE}`);
        if (cs < APPROVAL_TARGET_CONFIDENCE)  failedConditions.push(`confidence ${cs.toFixed(1)} < ${APPROVAL_TARGET_CONFIDENCE}`);
        if (rr < APPROVAL_TARGET_RISK_REWARD) failedConditions.push(`RR ${rr.toFixed(2)} < ${APPROVAL_TARGET_RISK_REWARD.toFixed(1)}`);
        if (isStaleSignal(candidate))         failedConditions.push('feed freshness stale');
        reasonMissed = failedConditions.length > 0
          ? `Surfaced as ${tier} but blocked by: ${failedConditions.join(', ')}`
          : `Surfaced as ${tier} but did not clear the strict gate`;
      } else {
        reasonMissed = 'No candidate generated by the engine for this symbol';
      }
      const priority: MissedOpportunityItem['learningPriority'] =
        Math.abs(mv.movePercent) >= 5 ? 'HIGH'
        : Math.abs(mv.movePercent) >= 2 ? 'MEDIUM' : 'LOW';
      items.push({
        symbol:             sym,
        movePercent:        mv.movePercent,
        direction:          mv.direction,
        wasSignalGenerated: candidate != null,
        highestTierReached: tier,
        reasonMissed,
        failedConditions,
        suggestedReview:    candidate
          ? 'Review why this candidate did not clear the strict gate — analyst approval required.'
          : 'Review why no candidate was generated — analyst approval required.',
        learningPriority:   priority,
      });
    }
    items.sort((a, b) => Math.abs(b.movePercent ?? 0) - Math.abs(a.movePercent ?? 0));
    return { items, status: items.length > 0 ? 'COMPLETE' : 'PARTIAL' };
  }

  // Path B: no market-movers — derive from non-approved candidates
  // where livePrice has moved positively vs entry. This is a real
  // observation (not fabricated) but is naturally narrower than a
  // proper market-mover comparison, so mark PARTIAL.
  const nonApproved: Array<{ s: RankableSignal; tier: MissedOpportunityItem['highestTierReached'] }> = [
    ...input.signals.highPotential.map((s) => ({ s, tier: 'HIGH_POTENTIAL' as const })),
    ...input.signals.watchlist.map((s)     => ({ s, tier: 'WATCHLIST' as const })),
    ...input.signals.developing.map((s)    => ({ s, tier: 'WATCHLIST' as const })),
    ...input.signals.scannerCandidates.map((s) => ({ s, tier: 'WATCHLIST' as const })),
    ...input.signals.rejected.map((s)      => ({ s, tier: 'REJECTED' as const })),
    ...input.signals.riskRestricted.map((s) => ({ s, tier: 'REJECTED' as const })),
  ];
  const items: MissedOpportunityItem[] = [];
  for (const { s, tier } of nonApproved) {
    const move = computeMoveInDirection(s);
    if (move == null || move < 1.5) continue; // 1.5% threshold for "meaningful" intraday move
    const sym = String(s.symbol ?? s.tradingsymbol ?? '').toUpperCase();
    if (!sym) continue;
    const fs = getSignalFinalScore(s);
    const cs = getSignalConfidence(s);
    const rr = getSignalRiskReward(s);
    const failedConditions: string[] = [];
    if (fs < APPROVAL_TARGET_FINAL_SCORE) failedConditions.push(`final ${fs.toFixed(1)} < ${APPROVAL_TARGET_FINAL_SCORE}`);
    if (cs < APPROVAL_TARGET_CONFIDENCE)  failedConditions.push(`confidence ${cs.toFixed(1)} < ${APPROVAL_TARGET_CONFIDENCE}`);
    if (rr < APPROVAL_TARGET_RISK_REWARD) failedConditions.push(`RR ${rr.toFixed(2)} < ${APPROVAL_TARGET_RISK_REWARD.toFixed(1)}`);
    if (isStaleSignal(s))                 failedConditions.push('feed freshness stale');
    items.push({
      symbol:             sym,
      movePercent:        Math.round(move * 100) / 100,
      direction:          move >= 0 ? 'UP' : 'DOWN',
      wasSignalGenerated: true,
      highestTierReached: tier,
      reasonMissed:       failedConditions.length > 0
        ? `Reached ${tier} but did not clear: ${failedConditions.join(', ')}`
        : `Reached ${tier} but did not clear the strict gate`,
      failedConditions,
      suggestedReview:    'Operator review required before scoring weight change.',
      learningPriority:   Math.abs(move) >= 4 ? 'HIGH' : Math.abs(move) >= 2.5 ? 'MEDIUM' : 'LOW',
    });
  }
  items.sort((a, b) => Math.abs(b.movePercent ?? 0) - Math.abs(a.movePercent ?? 0));
  // Cap at 25 so the page render stays bounded.
  return { items: items.slice(0, 25), status: items.length > 0 ? 'PARTIAL' : 'INSUFFICIENT_DATA' };
}

// ── Sector / time-window / regime ───────────────────────────────

export function buildSectorPerformance(
  input: DailyReportInput,
): DailySectorPerformance {
  // Sector is not joined onto signal rows in the current schema.
  // q365_universe has sector but the response payload does not surface
  // it. Mark INSUFFICIENT_DATA rather than fabricate a join.
  const allRows: RankableSignal[] = [
    ...input.signals.approved, ...input.signals.highPotential,
    ...input.signals.watchlist, ...input.signals.developing,
    ...input.signals.scannerCandidates, ...input.signals.riskRestricted,
    ...input.signals.rejected,
  ];
  const sectorBuckets = new Map<string, { total: number; approved: number; positive: number; withOutcome: number }>();
  for (const r of allRows) {
    const sector = String((r as any).sector ?? '').trim();
    if (!sector) continue;
    const b = sectorBuckets.get(sector) ?? { total: 0, approved: 0, positive: 0, withOutcome: 0 };
    b.total++;
    if (input.signals.approved.includes(r)) b.approved++;
    const m = computeMoveInDirection(r);
    if (m != null) {
      b.withOutcome++;
      if (m >= 0.5) b.positive++;
    }
    sectorBuckets.set(sector, b);
  }
  if (sectorBuckets.size === 0) {
    return {
      bestSectors: [],
      weakSectors: [],
      status:      'INSUFFICIENT_DATA',
      notes:       ['Sector field is not joined onto signal rows yet — sector performance unavailable.'],
    };
  }
  const items: SectorPerformanceItem[] = [];
  for (const [sector, b] of sectorBuckets) {
    const winRate = b.withOutcome > 0 ? safePct(b.positive, b.withOutcome) : null;
    items.push({
      sector,
      totalSignals:    b.total,
      approvedCount:   b.approved,
      performingCount: b.withOutcome > 0 ? b.positive : null,
      winRate,
      notes:           winRate != null
        ? `${b.positive}/${b.withOutcome} in-direction (${winRate}%)`
        : `${b.total} signals; outcome data unavailable`,
    });
  }
  items.sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));
  const half = Math.max(1, Math.ceil(items.length / 2));
  return {
    bestSectors: items.slice(0, Math.min(5, half)),
    weakSectors: items.slice(-Math.min(5, half)).reverse(),
    status:      items.some((i) => i.winRate != null) ? 'PARTIAL' : 'INSUFFICIENT_DATA',
    notes:       [],
  };
}

export function buildTimeWindowPerformance(
  input: DailyReportInput,
): DailyTimeWindowPerformance {
  // The signal rows carry `generated_at` but the platform does not
  // persist outcome timestamps in a way the report can read here.
  // The window assignment by generated_at is real, but the win-rate
  // would need post-signal outcome events. Without those events,
  // we surface counts only and mark PARTIAL.
  const buckets = new Map<string, { total: number; approved: number; positive: number; withOutcome: number }>();
  const allRows: Array<{ r: RankableSignal; approved: boolean }> = [
    ...input.signals.approved.map((r)         => ({ r, approved: true })),
    ...input.signals.highPotential.map((r)    => ({ r, approved: false })),
    ...input.signals.watchlist.map((r)        => ({ r, approved: false })),
    ...input.signals.developing.map((r)       => ({ r, approved: false })),
    ...input.signals.scannerCandidates.map((r) => ({ r, approved: false })),
    ...input.signals.rejected.map((r)         => ({ r, approved: false })),
  ];
  const windowOf = (iso: unknown): string | null => {
    if (typeof iso !== 'string' || !iso) return null;
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return null;
    // Convert to IST (UTC+5:30) for the NSE windowing.
    const ist = new Date(d.getTime() + (5.5 * 3600_000));
    const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (m >= 555 && m < 630) return '09:15-10:30';
    if (m >= 630 && m < 720) return '10:30-12:00';
    if (m >= 720 && m < 810) return '12:00-13:30';
    if (m >= 810 && m < 930) return '13:30-15:30';
    return null;
  };

  for (const { r, approved } of allRows) {
    const w = windowOf((r as any).generated_at);
    if (!w) continue;
    const b = buckets.get(w) ?? { total: 0, approved: 0, positive: 0, withOutcome: 0 };
    b.total++;
    if (approved) b.approved++;
    const m = computeMoveInDirection(r);
    if (m != null) {
      b.withOutcome++;
      if (m >= 0.5) b.positive++;
    }
    buckets.set(w, b);
  }
  if (buckets.size === 0) {
    return {
      bestTimeWindows: [],
      weakTimeWindows: [],
      status:          'INSUFFICIENT_DATA',
      notes:           ['Signals do not carry usable generated_at timestamps for window analysis.'],
    };
  }
  const items: TimeWindowPerformanceItem[] = [];
  for (const [w, b] of buckets) {
    const winRate = b.withOutcome > 0 ? safePct(b.positive, b.withOutcome) : null;
    items.push({
      window:          w,
      totalSignals:    b.total,
      approvedCount:   b.approved,
      performingCount: b.withOutcome > 0 ? b.positive : null,
      winRate,
      notes:           winRate != null ? `${winRate}% in-direction` : `${b.total} signals, outcome unavailable`,
    });
  }
  const order = ['09:15-10:30', '10:30-12:00', '12:00-13:30', '13:30-15:30'];
  items.sort((a, b) => order.indexOf(a.window) - order.indexOf(b.window));
  return {
    bestTimeWindows: [...items].sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1)).slice(0, 2),
    weakTimeWindows: [...items].sort((a, b) => (a.winRate ?? 999) - (b.winRate ?? 999)).slice(0, 2),
    status:          items.some((i) => i.winRate != null) ? 'PARTIAL' : 'INSUFFICIENT_DATA',
    notes:           [],
  };
}

export function buildMarketRegimeReview(
  input: DailyReportInput,
): MarketRegimeReview {
  // Average market_regime factor across the day's signal pool. Real
  // data — Phase-4 emits this per row. We classify the dominant regime
  // by the average value.
  const pool: RankableSignal[] = [
    ...input.signals.approved, ...input.signals.highPotential,
    ...input.signals.watchlist, ...input.signals.developing,
    ...input.signals.scannerCandidates,
  ];
  let regimeSum = 0;
  let regimeCount = 0;
  let highCount = 0;
  let mediumCount = 0;
  let avoidCount = 0;
  for (const r of pool) {
    const f = readFactorScores(r);
    if (f.market_regime != null) {
      regimeSum += f.market_regime;
      regimeCount++;
    }
    const cb = String((r as any).conviction_band ?? '').toLowerCase();
    if (cb === 'high')   highCount++;
    if (cb === 'medium') mediumCount++;
    if (cb === 'avoid')  avoidCount++;
  }
  const avgRegime = regimeCount > 0 ? Math.round((regimeSum / regimeCount) * 10) / 10 : null;
  const regime: string = avgRegime == null
    ? 'UNKNOWN'
    : avgRegime >= 70 ? 'SUPPORTIVE'
    : avgRegime >= 55 ? 'NEUTRAL'
    : avgRegime >= 40 ? 'CHOPPY'
    :                   'UNFAVOURABLE';

  const notes: string[] = [];
  if (avgRegime == null) {
    notes.push('Market regime factor not populated on today\'s signals.');
  } else {
    notes.push(`Average market regime factor: ${avgRegime}`);
    notes.push(`Conviction distribution — high:${highCount}, medium:${mediumCount}, avoid:${avoidCount}`);
  }
  if (!input.marketStatus.isOpen) {
    notes.push('Market is closed — regime read is based on last-close factor inputs.');
  }

  let best: string | null = null;
  let weak: string | null = null;
  if (regime === 'SUPPORTIVE') {
    best = 'Trend + Momentum confirmation setups perform best when regime is supportive.';
    weak = 'Counter-trend reversal setups underperform under supportive regime.';
  } else if (regime === 'CHOPPY' || regime === 'UNFAVOURABLE') {
    best = 'Range / mean-reversion and tight-RR setups are preferred under choppy regimes.';
    weak = 'High-conviction trend setups underperform in choppy regimes.';
  } else if (regime === 'NEUTRAL') {
    best = 'Mixed factor confluence (trend + volume) preferred under neutral regimes.';
    weak = 'Single-factor reliant setups underperform under neutral regimes.';
  }

  return {
    detectedRegime:        regime,
    regimeConfidence:      avgRegime,
    bestStrategyForRegime: best,
    weakStrategyForRegime: weak,
    notes,
  };
}

// ── Block reasons ──────────────────────────────────────────────

const BLOCK_REASON_IMPACT: Record<string, 'LOW' | 'MEDIUM' | 'HIGH'> = {
  'LOW_RR':                       'HIGH',
  'REJECTED_LOW_RR':              'HIGH',
  'REJECTED_LOW_FINAL_SCORE':     'HIGH',
  'REJECTED_LOW_CONFIDENCE':      'HIGH',
  'REJECTED_LIVE_INVALIDATED':    'HIGH',
  'REJECTED_STALE_DATA':          'MEDIUM',
  'REJECTED_HIGH_VOLATILITY':     'MEDIUM',
  'REJECTED_MARKET_REGIME':       'MEDIUM',
  'REJECTED_LOW_LIQUIDITY':       'MEDIUM',
  'REJECTED_PORTFOLIO_FIT':       'LOW',
  'REJECTED_FAILED_STABILITY':    'LOW',
  'REJECTED_NO_STRATEGY':         'LOW',
  'REJECTED_NO_EDGE':             'LOW',
};

const explainBlockReason = (reason: string): string => {
  const u = reason.toUpperCase();
  if (u.includes('RR') || u.includes('REWARD'))    return 'Reward-to-risk ratio fell below the institutional minimum.';
  if (u.includes('CONFIDENCE'))                    return 'Confidence score fell below the institutional confidence floor.';
  if (u.includes('FINAL'))                         return 'Final score fell below the institutional final-score floor.';
  if (u.includes('STALE') || u.includes('FRESH'))  return 'Provider feed was stale beyond the freshness window.';
  if (u.includes('VOLATIL'))                       return 'Implied volatility above the institutional stress ceiling.';
  if (u.includes('REGIME'))                        return 'Market regime not supportive of the trade direction.';
  if (u.includes('LIQUID') || u.includes('VOLUME')) return 'Liquidity or volume confirmation below institutional floor.';
  if (u.includes('PORTFOLIO'))                     return 'Portfolio fit constraint blocked this row.';
  if (u.includes('STABILITY'))                     return 'Setup did not yet pass the stability gate.';
  if (u.includes('STRATEGY'))                      return 'No strategy pattern matched the current price action.';
  if (u.includes('EDGE'))                          return 'Expected edge below the institutional edge floor.';
  if (u.includes('INVALID'))                       return 'Live revalidation invalidated the setup.';
  if (u.includes('EXECUTION'))                     return 'Execution explicitly blocked by the engine.';
  return 'Specific gate blocked this row — see per-row due diligence for detail.';
};

export function buildTopBlockReasons(
  input: DailyReportInput,
): BlockReasonItem[] {
  // Prefer the Phase-2 summary when caller passed it through.
  if (input.dueDiligenceSummary && Array.isArray(input.dueDiligenceSummary.topBlockReasons)) {
    return input.dueDiligenceSummary.topBlockReasons.map((r) => ({
      reason:       r.reason,
      count:        r.count,
      impact:       BLOCK_REASON_IMPACT[r.reason.toUpperCase()] ?? 'MEDIUM',
      explanation:  explainBlockReason(r.reason),
    }));
  }
  // Fallback — recompute from rejection_codes / rejection_reasons.
  const counts = new Map<string, number>();
  const bump = (k: string) => {
    if (!k) return;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  };
  for (const r of [...input.signals.rejected, ...input.signals.riskRestricted, ...input.signals.developing]) {
    const codes = Array.isArray((r as any).rejection_codes) ? (r as any).rejection_codes : [];
    if (codes.length > 0) {
      for (const c of codes) bump(String(c).toUpperCase());
    } else if ((r as any).rejection_reason) {
      bump(String((r as any).rejection_reason));
    }
  }
  return Array.from(counts.entries())
    .map(([reason, count]) => ({
      reason,
      count,
      impact:      BLOCK_REASON_IMPACT[reason.toUpperCase()] ?? 'MEDIUM',
      explanation: explainBlockReason(reason),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
}

// ── Learning recommendations ───────────────────────────────────

export function buildLearningRecommendations(
  input: DailyReportInput,
  indicators: DailyIndicatorPerformance,
  perf: DailySignalPerformance,
  blockers: BlockReasonItem[],
): LearningRecommendationItem[] {
  const recs: LearningRecommendationItem[] = [];

  // Indicator-driven observations.
  for (const ind of indicators.bestIndicators) {
    if (ind.winRate == null || ind.totalSignals < 3) continue;
    recs.push({
      title:            `Review weight of ${ind.indicator}`,
      observation:      `${ind.indicator} showed a strong in-direction rate today (${ind.winRate}%).`,
      evidence:         `Total signals where factor was strong: ${ind.totalSignals}. Average move: ${ind.avgMovePercent ?? 'N/A'}%.`,
      suggestedAction:  `Consider whether ${ind.indicator} weight should be increased in future scoring cycles. Analyst review required.`,
      governanceStatus: 'REVIEW_REQUIRED',
      priority:         (ind.winRate >= 75 && ind.totalSignals >= 5) ? 'HIGH' : 'MEDIUM',
    });
  }
  for (const ind of indicators.weakIndicators) {
    if (ind.winRate == null || ind.totalSignals < 3) continue;
    recs.push({
      title:            `Investigate underperformance of ${ind.indicator}`,
      observation:      `${ind.indicator} produced low in-direction rate today (${ind.winRate}%).`,
      evidence:         `Total signals where factor was strong: ${ind.totalSignals}. Average move: ${ind.avgMovePercent ?? 'N/A'}%.`,
      suggestedAction:  `Audit recent ${ind.indicator} computations and confirm input data quality. Do not apply weight changes automatically.`,
      governanceStatus: 'DO_NOT_APPLY_AUTOMATICALLY',
      priority:         ind.winRate < 30 ? 'HIGH' : 'MEDIUM',
    });
  }

  // Blocker-driven observations.
  const topBlocker = blockers[0];
  if (topBlocker && topBlocker.count >= 5) {
    recs.push({
      title:            `Daily top blocker: ${topBlocker.reason}`,
      observation:      `${topBlocker.count} candidates blocked by "${topBlocker.reason}".`,
      evidence:         `Top rejection cause in today's review pool. ${topBlocker.explanation}`,
      suggestedAction:  topBlocker.impact === 'HIGH'
        ? 'Review whether this gate is calibrated correctly. Analyst approval required before any threshold change.'
        : 'Monitor this rejection cause across the week before any action.',
      governanceStatus: 'REVIEW_REQUIRED',
      priority:         topBlocker.impact === 'HIGH' ? 'HIGH' : 'MEDIUM',
    });
  }

  // Rejection false-negative observations.
  if (perf.rejectionFalseNegativeRate != null && perf.rejectionFalseNegativeRate >= 30) {
    recs.push({
      title:            'Rejected pool moved in-direction at unusual rate',
      observation:      `${perf.rejectionFalseNegativeRate}% of rejected candidates moved in-direction today.`,
      evidence:         `Rejected pool size: ${perf.rejectedTotal}.`,
      suggestedAction:  'Sample rejected candidates and confirm rejection rules are well-calibrated. Do not adjust automatically.',
      governanceStatus: 'DO_NOT_APPLY_AUTOMATICALLY',
      priority:         'HIGH',
    });
  }

  if (recs.length === 0) {
    recs.push({
      title:            'No learning recommendations',
      observation:      'No observable patterns crossed the recommendation threshold today.',
      evidence:         'Insufficient outcome data or below-threshold signal counts.',
      suggestedAction:  'Continue monitoring; no action required.',
      governanceStatus: 'READY_FOR_ANALYST_REVIEW',
      priority:         'LOW',
    });
  }

  return recs;
}

// ── Data quality summary ───────────────────────────────────────

export function buildDailyDataQualitySummary(
  input: DailyReportInput,
): DailyDataQuality {
  const warnings: string[] = [];
  if (input.dataQuality.isBootstrap) warnings.push('Operating on bootstrap-seeded data — outcomes not validated by live broker feed.');
  if (input.dataQuality.isFallback)  warnings.push('Provider in fallback mode — data path degraded.');
  if (input.dataQuality.staleMinutes != null && input.dataQuality.staleMinutes > 30) {
    warnings.push(`Feed stale ${input.dataQuality.staleMinutes}m — beyond institutional freshness window.`);
  }
  if (input.dataQuality.coveragePercent != null && input.dataQuality.coveragePercent < 60) {
    warnings.push(`Symbol coverage low (${input.dataQuality.coveragePercent}%).`);
  }
  return {
    provider:         input.dataQuality.provider,
    lastSuccessAt:    input.dataQuality.lastSuccessAt,
    staleMinutes:     input.dataQuality.staleMinutes,
    symbolsRequested: input.dataQuality.symbolsRequested,
    symbolsReturned:  input.dataQuality.symbolsReturned,
    coveragePercent:  input.dataQuality.coveragePercent,
    warnings,
  };
}

// ── Executive summary ──────────────────────────────────────────

function buildExecutiveSummary(
  perf: DailySignalPerformance,
  indicators: DailyIndicatorPerformance,
  regime: MarketRegimeReview,
  blockers: BlockReasonItem[],
  marketOpen: boolean,
  dataStatus: DailyReportDataStatus,
): DailyExecutiveSummary {
  const approvedSentence = perf.approvedTotal === 0
    ? 'No approved execution signal cleared the institutional gate today.'
    : `The engine identified ${perf.approvedTotal} approved signal${perf.approvedTotal === 1 ? '' : 's'}.`;
  const monitoredSentence = `${perf.highPotentialTotal} high-potential and ${perf.watchlistTotal} watchlist candidate${perf.watchlistTotal === 1 ? '' : 's'} were monitored.`;
  const blockerSentence = blockers[0]
    ? `Top block reason: ${blockers[0].reason} (${blockers[0].count} candidates).`
    : 'No dominant block reason emerged today.';
  const regimeSentence = regime.detectedRegime === 'UNKNOWN'
    ? ''
    : ` Market regime read as ${regime.detectedRegime.toLowerCase()}.`;

  const summary = `${approvedSentence} ${monitoredSentence} ${blockerSentence}${regimeSentence}`;
  const headline = perf.approvedTotal === 0
    ? 'No approved signals today — monitored candidates only.'
    : `${perf.approvedTotal} approved signals — ${perf.approvedWinRate != null ? `${perf.approvedWinRate}% in-direction` : 'outcome data pending'}`;

  const keyTakeaways: string[] = [];
  if (perf.approvedWinRate != null)        keyTakeaways.push(`Approved win-rate (in-direction): ${perf.approvedWinRate}%`);
  if (perf.rejectionFalseNegativeRate != null && perf.rejectionFalseNegativeRate >= 20) {
    keyTakeaways.push(`Rejected pool moved in-direction at ${perf.rejectionFalseNegativeRate}%`);
  }
  for (const ind of indicators.bestIndicators.slice(0, 2)) {
    if (ind.winRate != null) keyTakeaways.push(`${ind.indicator} performing (${ind.winRate}% in-direction).`);
  }

  const riskWarnings: string[] = [];
  if (dataStatus === 'STALE')        riskWarnings.push('Data path is stale — confidence in outcomes is reduced.');
  if (dataStatus === 'FALLBACK')     riskWarnings.push('Provider running on fallback — quality degraded.');
  if (dataStatus === 'BOOTSTRAP')    riskWarnings.push('Bootstrap data in use — not a live broker feed.');
  if (dataStatus === 'INSUFFICIENT_DATA') riskWarnings.push('Insufficient post-signal data — many sections are partial or unavailable.');
  if (!marketOpen)                   riskWarnings.push('Market is closed — outcomes reflect last-close moves only.');

  const tomorrowFocus: string[] = [];
  if (blockers[0]) {
    tomorrowFocus.push(`Watch for ${blockers[0].reason.toLowerCase()} cases tomorrow.`);
  }
  if (regime.bestStrategyForRegime) {
    tomorrowFocus.push(regime.bestStrategyForRegime);
  }
  for (const ind of indicators.weakIndicators.slice(0, 1)) {
    tomorrowFocus.push(`Audit ${ind.indicator} computation before next cycle.`);
  }
  if (tomorrowFocus.length === 0) {
    tomorrowFocus.push('Continue monitoring — no specific focus required.');
  }

  return { headline, summary, keyTakeaways, riskWarnings, tomorrowFocus };
}

// ── Master report builder ──────────────────────────────────────

const todayISO = (date?: string): string => {
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
  return new Date().toISOString().slice(0, 10);
};

const inferDataStatus = (q: DailyReportInput['dataQuality']): DailyReportDataStatus => {
  if (q.isBootstrap) return 'BOOTSTRAP';
  if (q.isFallback)  return 'FALLBACK';
  if (q.staleMinutes != null && q.staleMinutes > 30) return 'STALE';
  if (q.lastSuccessAt) return 'LIVE';
  return 'INSUFFICIENT_DATA';
};

export function buildDailySignalReport(
  input: DailyReportInput,
): DailySignalReport {
  // Sort each pool by institutional ranking once so any downstream
  // ordering is consistent with the live page.
  const sorted = (rows: RankableSignal[]) => rankSignalsByInstitutionalScore(rows);
  const sortedInput: DailyReportInput = {
    ...input,
    signals: {
      approved:           sorted(input.signals.approved),
      highPotential:      sorted(input.signals.highPotential),
      watchlist:          sorted(input.signals.watchlist),
      developing:         sorted(input.signals.developing),
      scannerCandidates:  sorted(input.signals.scannerCandidates),
      riskRestricted:     sorted(input.signals.riskRestricted),
      rejected:           sorted(input.signals.rejected),
      decayedPool:        input.signals.decayedPool ? sorted(input.signals.decayedPool) : undefined,
    },
  };

  const signalPerformance     = buildSignalPerformanceSummary(sortedInput);
  const indicatorPerformance  = buildIndicatorPerformance(sortedInput);
  const missed                = buildMissedOpportunities(sortedInput);
  const sectorPerformance     = buildSectorPerformance(sortedInput);
  const timeWindowPerformance = buildTimeWindowPerformance(sortedInput);
  const marketRegimeReview    = buildMarketRegimeReview(sortedInput);
  const topBlockReasons       = buildTopBlockReasons(sortedInput);
  const dataQuality           = buildDailyDataQualitySummary(sortedInput);
  const learningRecommendations = buildLearningRecommendations(
    sortedInput, indicatorPerformance, signalPerformance, topBlockReasons,
  );

  const dataStatus = inferDataStatus(input.dataQuality);
  const executiveSummary = buildExecutiveSummary(
    signalPerformance,
    indicatorPerformance,
    marketRegimeReview,
    topBlockReasons,
    input.marketStatus.isOpen,
    dataStatus,
  );

  // Compute overall report status — if every measurable section has
  // outcome data the status is COMPLETE; if at least one section
  // could be populated the status is PARTIAL; otherwise INSUFFICIENT.
  const measurableSections = [
    indicatorPerformance.status,
    sectorPerformance.status,
    timeWindowPerformance.status,
    missed.status,
  ];
  const anyComplete = measurableSections.includes('COMPLETE');
  const anyPartial  = measurableSections.some((s) => s === 'COMPLETE' || s === 'PARTIAL');
  const reportStatus: DailyReportStatus =
    anyComplete ? 'COMPLETE' : (anyPartial ? 'PARTIAL' : 'INSUFFICIENT_DATA');

  const warnings: string[] = [];
  if (reportStatus !== 'COMPLETE') {
    warnings.push('Daily report is partial — some sections are awaiting post-signal data.');
  }
  if (signalPerformance.insufficientDataReasons.length > 0) {
    warnings.push(...signalPerformance.insufficientDataReasons);
  }

  // PHASE_B_MANIPULATION — derive impact summary from the manipulationRisk
  // envelope already attached to each signal. Pure aggregation (no DB
  // round-trip); the synthesised globalFreshness comes from the first
  // risk envelope because every envelope on a single response shares
  // the same global snapshot.
  let manipulationFilterImpact:
    DailySignalReport['manipulationFilterImpact'] = null;
  try {
    const everyReviewed = [
      ...sortedInput.signals.approved,
      ...sortedInput.signals.highPotential,
      ...sortedInput.signals.developing,
      ...sortedInput.signals.scannerCandidates,
      ...sortedInput.signals.watchlist,
      ...sortedInput.signals.riskRestricted,
      ...sortedInput.signals.rejected,
    ] as Array<{ manipulationRisk?: import('@/lib/manipulation-engine/manipulationSignalRisk').ManipulationRisk }>;
    const first = everyReviewed.find((r) => r.manipulationRisk)?.manipulationRisk;
    if (first) {
      manipulationFilterImpact = summarizeManipulationImpactSync(everyReviewed, {
        latestEventDate:   first.latestEventDate,
        latestCandleDate:  null,
        latestScanAt:      first.latestScanAt,
        latestTradingDate: null,
        isStale:           first.freshnessStatus === 'STALE',
        daysLag:           null,
        status:            first.freshnessStatus,
        reason:            first.explanation,
      });
    }
  } catch (err) {
    console.warn('[dailySignalReport] manipulation impact build failed:', err);
  }

  return {
    reportDate:                todayISO(input.reportDate),
    generatedAt:               new Date().toISOString(),
    marketStatus:              input.marketStatus.label,
    dataStatus,
    reportStatus,
    executiveSummary,
    signalPerformance,
    indicatorPerformance,
    missedOpportunities:       missed.items,
    missedOpportunitiesStatus: missed.status,
    sectorPerformance,
    timeWindowPerformance,
    marketRegimeReview,
    topBlockReasons,
    learningRecommendations,
    dataQuality,
    warnings,
    manipulationFilterImpact,
  };
}

// ── Lightweight preview for /api/signals integration ───────────

export interface DailyReportPreview {
  reportDate:               string;
  reportStatus:             DailyReportStatus;
  headline:                 string;
  approvedWinRate:          number | null;
  highPotentialPerformed:   number | null;
  topBlockReason:           string | null;
  dataStatus:               DailyReportDataStatus;
  ready:                    boolean;
}

export function buildDailyReportPreview(
  input: DailyReportInput,
): DailyReportPreview {
  const r = buildDailySignalReport(input);
  return {
    reportDate:             r.reportDate,
    reportStatus:           r.reportStatus,
    headline:               r.executiveSummary.headline,
    approvedWinRate:        r.signalPerformance.approvedWinRate,
    highPotentialPerformed: r.signalPerformance.highPotentialPerformed,
    topBlockReason:         r.topBlockReasons[0]?.reason ?? null,
    dataStatus:             r.dataStatus,
    ready:                  r.reportStatus === 'COMPLETE' || r.reportStatus === 'PARTIAL',
  };
}

/** Cheap variant that reads already-computed counters from the
 *  response-assembly pipeline. Used by the main /api/signals
 *  response so the dashboard can show the small "ready / partial /
 *  pending" preview chip without running the full report builder. */
export interface LightweightPreviewInput {
  approvedTotal:            number;
  approvedSuccess:          number | null;
  approvedFailed:           number | null;
  highPotentialTotal:       number;
  highPotentialPerformed:   number | null;
  watchlistTotal:           number;
  rejectedTotal:            number;
  topBlockReason:           string | null;
  marketOpen:               boolean;
  isBootstrap:              boolean;
  isFallback:               boolean;
  staleMinutes:             number | null;
  reportDate?:              string;
}

export function buildLightweightDailyReportPreview(
  input: LightweightPreviewInput,
): DailyReportPreview {
  const dataStatus: DailyReportDataStatus =
      input.isBootstrap ? 'BOOTSTRAP'
    : input.isFallback  ? 'FALLBACK'
    : (input.staleMinutes != null && input.staleMinutes > 30) ? 'STALE'
    : 'LIVE';

  const approvedWinRate = (input.approvedSuccess != null && input.approvedTotal > 0)
    ? Math.round((input.approvedSuccess / input.approvedTotal) * 1000) / 10
    : null;

  // Mirrors buildDailySignalReport's status resolution: when we have
  // any outcome counter the preview is at least PARTIAL.
  const hasOutcome = input.approvedSuccess != null || input.highPotentialPerformed != null;
  const reportStatus: DailyReportStatus = hasOutcome ? 'PARTIAL' : 'INSUFFICIENT_DATA';

  const headline = input.approvedTotal === 0
    ? 'No approved signals today — monitored candidates only.'
    : `${input.approvedTotal} approved signals — ${approvedWinRate != null ? `${approvedWinRate}% in-direction` : 'outcome data pending'}`;

  return {
    reportDate:             input.reportDate ?? new Date().toISOString().slice(0, 10),
    reportStatus,
    headline,
    approvedWinRate,
    highPotentialPerformed: input.highPotentialPerformed,
    topBlockReason:         input.topBlockReason,
    dataStatus,
    ready:                  hasOutcome,
  };
}
