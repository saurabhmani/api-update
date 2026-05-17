/**
 * Live single-instrument analysis service
 *
 * Canonical entry point for on-demand per-symbol signal analysis
 * (watchlist intelligence, `?action=instrument` lookups, trade-setup
 * generation, admin recompute). All logic runs through the new engine's
 * pure helpers (buildSignalFeatures → runAllStrategies) — this module is
 * the single signal system for live (non-pipeline) paths.
 *
 * The batch/persisted pipeline lives in
 * `src/lib/signal-engine/pipeline/generatePhase4Signals.ts` and writes to
 * q365_signals. This module returns an in-memory `Signal` and leaves
 * persistence to callers (persistSignal / logRejection).
 */

import { db } from '@/lib/db';
import {
  buildSignalFeatures,
  runAllStrategies,
  detectMarketRegime,
  computeRelativeStrength,
  DEFAULT_PHASE1_CONFIG,
} from '@/lib/signal-engine';
import type {
  Candle,
  SignalFeatures,
  StrategyCandidate,
  MarketRegimeLabel,
  StrategyName,
  ConfidenceBreakdown,
} from '@/lib/signal-engine';
import {
  runRejectionEngine,
  classifySignalStatus,
  type RejectionInput,
  type SignalStatus,
} from '../core/runRejectionEngine';
import type { PortfolioFitResult, ExecutionReadiness } from '../types/phase3.types';
import { runPhase4Scoring, type FinalScoreBand } from '../scoring/phase4FactorAdapter';

// ════════════════════════════════════════════════════════════════
//  PUBLIC TYPES — canonical shape for live per-instrument analysis
// ════════════════════════════════════════════════════════════════

export type SignalDirection = 'BUY' | 'SELL' | 'HOLD';
export type Timeframe       = 'swing' | 'positional' | 'intraday';
export type RiskLevel       = 'Low' | 'Medium' | 'High' | 'Very High';
export type MarketRegime    = 'STRONG_BULL' | 'BULL' | 'NEUTRAL' | 'CHOPPY' | 'BEAR' | 'STRONG_BEAR';

export type ScenarioTag =
  | 'TREND_CONTINUATION'     | 'BREAKOUT_CONTINUATION' | 'PULLBACK_IN_TREND'
  | 'MEAN_REVERSION'         | 'MOMENTUM_EXPANSION'    | 'RELATIVE_STRENGTH_LEADER'
  | 'VOLATILITY_COMPRESSION' | 'EVENT_DRIVEN'          | 'SECTOR_ROTATION'
  | 'WATCHLIST_OPPORTUNITY'  | 'NO_STRATEGY';

export interface FactorScores {
  momentum:           number;
  trend_quality:      number;
  volatility:         number;
  liquidity:          number;
  participation:      number;
  relative_strength:  number;
  breakout_readiness: number;
  mean_reversion:     number;
}

export interface SignalReason {
  rank:         number;
  factor_key:   string | null;
  text:         string;
  contribution: number;
}

export interface Signal {
  instrument_key:    string;
  tradingsymbol:     string;
  exchange:          string;

  direction:         SignalDirection;
  timeframe:         Timeframe;

  confidence:        number;
  risk_score:        number;
  opportunity_score: number;
  portfolio_fit:     number;

  conviction_band:   string;
  market_stance:     string;
  regime_alignment:  number;

  rejection_reasons: string[];
  rejection_codes:   string[];
  signal_status:     SignalStatus;
  // ── Phase-4 scoring (calculateFinalScore + 6-band) ──────────
  // Identical fields are attached to the batch ExecutableSignal
  // (generatePhase3Signals.ts) — live and batch outputs are
  // interchangeable.
  final_score:       number;
  classification:    FinalScoreBand;
  factor_scores_phase4: {
    strategy_quality:     number;
    trend_alignment:      number;
    momentum:             number;
    volume_confirmation:  number;
    risk_reward:          number;
    liquidity:            number;
    market_regime:        number;
    portfolio_fit:        number;
  };
  soft_warnings:     string[];
  blocked_by: {
    risk: boolean; portfolio: boolean; scenario: boolean;
    liquidity: boolean; data_quality: boolean; stance: boolean; regime: boolean;
  };

  risk:         RiskLevel;
  scenario_tag: ScenarioTag;
  regime:       MarketRegime;

  entry_price: number;
  stop_loss:   number;
  target1:     number;
  target2:     number;
  risk_reward: number;

  factor_scores:          FactorScores;
  confidence_components?: Record<string, number>;
  reasons:                SignalReason[];
  data_quality:           number;
  generated_at:           string;
  score_raw:              number;

  manipulation_score?:     number | null;
  manipulation_band?:      string | null;
  manipulation_warning?:   string | null;
  manipulation_penalized?: boolean;
}

// ════════════════════════════════════════════════════════════════
//  CANDLE PROVIDER + BENCHMARK CACHE
// ════════════════════════════════════════════════════════════════

async function fetchDailyCandles(symbol: string): Promise<Candle[]> {
  // Fetch the NEWEST 300 bars, then return them in ASC order for
  // the indicator code (which scans forward). Using
  // `ORDER BY ts ASC LIMIT 300` is a trap — it returns the
  // *oldest* 300 rows, so once a symbol has more than 300 bars
  // the engine silently reads year-old data. Wrap a DESC+LIMIT
  // subquery and re-sort ASC to get the right semantics.
  const { rows } = await db.query(
    `SELECT ts, open, high, low, close, volume FROM (
       SELECT ts, open, high, low, close, volume
         FROM market_data_daily
        WHERE symbol = ?
        ORDER BY ts DESC
        LIMIT 300
     ) t
     ORDER BY ts ASC`,
    [symbol],
  );
  return (rows as any[]).map((r) => ({
    ts:     r.ts,
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
    volume: Number(r.volume),
  }));
}

interface BenchmarkSnapshot {
  candles: Candle[];
  regime: ReturnType<typeof detectMarketRegime>;
  fetchedAt: number;
  /** Source tag for observability — operators need to know whether the
   *  regime label was derived from real NIFTY 50 bars or the synthetic
   *  cohort proxy. Defaulting to 'index' is a lie when the cohort path
   *  fired, and a misleading regime is worse than no regime. */
  source: 'index' | 'cohort_proxy';
}

const BENCHMARK_TTL_MS = 60_000;
/** Cohort-proxy basket size. 50 large-caps median-aggregated produces a
 *  stable index-like series; smaller baskets get noisy, larger ones
 *  drag in low-volume names that don't trade every day and create
 *  gaps. Tuned to balance smoothness vs. compute. */
const COHORT_PROXY_BASKET_SIZE = 50;
let benchmarkCache: BenchmarkSnapshot | null = null;

async function getBenchmarkSnapshot(): Promise<BenchmarkSnapshot | null> {
  const now = Date.now();
  if (benchmarkCache && now - benchmarkCache.fetchedAt < BENCHMARK_TTL_MS) {
    return benchmarkCache;
  }
  // 1. Preferred path — real NIFTY 50 bars from market_data_daily.
  try {
    const candles = await fetchDailyCandles(DEFAULT_PHASE1_CONFIG.benchmarkSymbol);
    if (candles.length >= DEFAULT_PHASE1_CONFIG.minCandleCount) {
      const regime = detectMarketRegime(candles);
      benchmarkCache = { candles, regime, fetchedAt: now, source: 'index' };
      return benchmarkCache;
    }
  } catch {
    /* fall through to cohort proxy */
  }
  // 2. Fallback — synthesise a NIFTY-shape series from the median
  //    daily OHLC of the most-liquid universe symbols. Why this works:
  //    NIFTY 50 itself is a market-cap-weighted basket; a median over
  //    the top large-caps tracks the same regime signal closely enough
  //    for `detectMarketRegime` (which only reads trend / volatility
  //    features). Engineered as an explicit second-tier so the engine
  //    keeps producing signals when benchmark ingestion is broken
  //    (the actual root cause we hit: NIFTY 50 row count was 0). The
  //    `source: 'cohort_proxy'` tag flows through to logs so the
  //    operator can tell when the proxy fired.
  try {
    const proxy = await fetchCohortProxyCandles();
    if (proxy.length >= DEFAULT_PHASE1_CONFIG.minCandleCount) {
      const regime = detectMarketRegime(proxy);
      console.warn(
        `[SignalEngine] benchmark='NIFTY 50' empty — using cohort proxy (basket=${COHORT_PROXY_BASKET_SIZE}, bars=${proxy.length}, regime=${regime.label})`,
      );
      benchmarkCache = { candles: proxy, regime, fetchedAt: now, source: 'cohort_proxy' };
      return benchmarkCache;
    }
  } catch {
    /* fall through to null */
  }
  return null;
}

/**
 * Cohort proxy — synthesise a NIFTY-shape OHLC series from the median
 * daily bar across the most-liquid universe symbols.
 *
 * Method:
 *   1. Pick the top-N symbols by recent average daily turnover (close × volume).
 *   2. Pull each symbol's last 300 daily bars.
 *   3. Group bars by trading day; compute median open/high/low/close
 *      across the cohort. Volume is summed to keep volume-based
 *      indicators non-zero.
 *   4. Drop any day where fewer than half the basket reported a bar
 *      (suspect / partial trading day).
 *
 * Median, not mean: a single low-priced symbol's 5% pop wouldn't drag
 * the proxy; a price-equal-weighted mean would. Median preserves the
 * regime feel of the basket.
 */
async function fetchCohortProxyCandles(): Promise<Candle[]> {
  // Top-N by recent turnover. Looks at the most-recent 30 daily bars
  // so a one-day volume spike doesn't bias the basket.
  const { rows: cohortRows } = await db.query(
    `SELECT symbol
       FROM (
         SELECT symbol, AVG(close * volume) AS turnover, COUNT(*) AS bars
           FROM market_data_daily
          WHERE ts >= DATE_SUB(NOW(), INTERVAL 60 DAY)
          GROUP BY symbol
         HAVING bars >= 20
       ) t
       ORDER BY turnover DESC
       LIMIT ?`,
    [COHORT_PROXY_BASKET_SIZE],
  );
  const cohort = (cohortRows as any[]).map((r) => String(r.symbol)).filter(Boolean);
  if (cohort.length < 10) return [];

  const placeholders = cohort.map(() => '?').join(',');
  const { rows: barRows } = await db.query(
    `SELECT symbol, ts, open, high, low, close, volume
       FROM market_data_daily
      WHERE symbol IN (${placeholders})
        AND ts >= DATE_SUB(NOW(), INTERVAL 400 DAY)
      ORDER BY ts ASC`,
    cohort,
  );

  // Group by day. Use the date portion of `ts` as the bucket key so
  // any intraday timestamp variance across symbols collapses cleanly.
  const buckets = new Map<string, { open: number[]; high: number[]; low: number[]; close: number[]; volume: number; ts: Date }>();
  for (const r of barRows as any[]) {
    const tsRaw = r.ts;
    const ts = tsRaw instanceof Date ? tsRaw : new Date(tsRaw);
    if (Number.isNaN(ts.getTime())) continue;
    const key = ts.toISOString().slice(0, 10);
    let b = buckets.get(key);
    if (!b) {
      b = { open: [], high: [], low: [], close: [], volume: 0, ts };
      buckets.set(key, b);
    }
    const o = Number(r.open), h = Number(r.high), l = Number(r.low), c = Number(r.close), v = Number(r.volume);
    if (Number.isFinite(o)) b.open.push(o);
    if (Number.isFinite(h)) b.high.push(h);
    if (Number.isFinite(l)) b.low.push(l);
    if (Number.isFinite(c)) b.close.push(c);
    if (Number.isFinite(v)) b.volume += v;
  }

  const median = (xs: number[]): number => {
    if (xs.length === 0) return 0;
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const minPerDay = Math.max(5, Math.floor(cohort.length / 2));
  const out: Candle[] = [];
  for (const [, b] of [...buckets.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)) {
    if (b.close.length < minPerDay) continue;
    out.push({
      // Candle.ts is `string` (signalEngine.types.ts). The real
      // benchmark fetch passes through the raw MySQL value via an
      // `as any[]` cast, so its type is anything-goes; here the type
      // is explicit and we serialise to ISO to match.
      ts:     b.ts.toISOString(),
      open:   median(b.open),
      high:   median(b.high),
      low:    median(b.low),
      close:  median(b.close),
      volume: b.volume,
    });
  }
  // Cap at 300 to match the real-benchmark fetch length.
  return out.slice(-300);
}

// ════════════════════════════════════════════════════════════════
//  MAPPINGS — new engine → legacy shape
// ════════════════════════════════════════════════════════════════

function mapRegimeLabel(label: MarketRegimeLabel): MarketRegime {
  switch (label) {
    case 'Strong Bullish':        return 'STRONG_BULL';
    case 'Bullish':               return 'BULL';
    case 'Sideways':              return 'NEUTRAL';
    case 'Weak':                  return 'CHOPPY';
    case 'Bearish':               return 'BEAR';
    case 'High Volatility Risk':  return 'STRONG_BEAR';
    default:                      return 'NEUTRAL';
  }
}

function computeContextScore(label: MarketRegimeLabel): number {
  switch (label) {
    case 'Strong Bullish':       return 85;
    case 'Bullish':              return 70;
    case 'Sideways':             return 45;
    case 'Weak':                 return 30;
    case 'Bearish':              return 20;
    case 'High Volatility Risk': return 15;
    default:                     return 40;
  }
}

const STRATEGY_TO_SCENARIO: Record<StrategyName, ScenarioTag> = {
  bullish_breakout:       'BREAKOUT_CONTINUATION',
  bullish_pullback:       'PULLBACK_IN_TREND',
  bearish_breakdown:      'BREAKOUT_CONTINUATION',
  mean_reversion_bounce:  'MEAN_REVERSION',
  momentum_continuation:  'MOMENTUM_EXPANSION',
  bullish_divergence:     'MEAN_REVERSION',
  volume_climax_reversal: 'MEAN_REVERSION',
  gap_continuation:       'TREND_CONTINUATION',
  range_breakout:         'BREAKOUT_CONTINUATION',
  ema_crossover:          'TREND_CONTINUATION',
  oversold_bounce:        'MEAN_REVERSION',
  overbought_reversal:    'MEAN_REVERSION',
  weak_trend_breakdown:   'BREAKOUT_CONTINUATION',
  // Phase 4:
  failed_breakout_reversal:    'MEAN_REVERSION',
  bearish_pullback_rejection:  'BREAKOUT_CONTINUATION',
  volatility_squeeze_breakout: 'BREAKOUT_CONTINUATION',
  multi_timeframe_alignment:   'TREND_CONTINUATION',
  vwap_reclaim_long:           'MOMENTUM_EXPANSION',
  vwap_rejection_short:        'MEAN_REVERSION',
  opening_range_breakout:      'BREAKOUT_CONTINUATION',
  opening_range_breakdown:     'BREAKOUT_CONTINUATION',
};

function strategyDirection(strategy: StrategyName): SignalDirection {
  if (strategy === 'bearish_breakdown'
    || strategy === 'volume_climax_reversal'
    || strategy === 'overbought_reversal'
    || strategy === 'weak_trend_breakdown') return 'SELL';
  return 'BUY';
}

function mapRiskBand(band: string): RiskLevel {
  switch (band) {
    case 'Low Risk':       return 'Low';
    case 'Moderate Risk':  return 'Medium';
    case 'Elevated Risk':  return 'High';
    case 'High Risk':      return 'Very High';
    default:               return 'Medium';
  }
}

function mapConfidenceBand(band: string): string {
  switch (band) {
    case 'High Conviction': return 'high_conviction';
    case 'Actionable':      return 'actionable';
    case 'Watchlist':       return 'watchlist';
    default:                return 'reject';
  }
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function deriveFactorScores(f: SignalFeatures): FactorScores {
  const rsi      = f.momentum.rsi14 ?? 50;
  const adx      = f.momentum.adx ?? 15;
  const roc20    = f.momentum.roc20 ?? 0;
  const volRatio = f.volume.volumeVs20dAvg ?? 1;
  const atrPct   = f.volatility.atrPct ?? 1.5;

  return {
    momentum:           clamp(50 + (rsi - 50) * 0.8 + roc20 * 2),
    trend_quality:      clamp(
                          50 +
                          (adx - 20) * 2 +
                          (f.trend.closeAbove50Ema ? 10 : -10) +
                          (f.trend.closeAbove200Ema ? 10 : -10),
                        ),
    volatility:         clamp(100 - atrPct * 20),
    liquidity:          clamp(volRatio * 50),
    participation:      clamp(volRatio * 45 + (f.volume.obvSlope > 0 ? 15 : -5)),
    relative_strength:  clamp(50 + roc20 * 1.5),
    breakout_readiness: clamp(
                          40 +
                          (f.volatility.squeezed ? 25 : 0) +
                          Math.max(-20, 30 - f.structure.distanceToResistancePct * 3),
                        ),
    mean_reversion:     clamp(rsi <= 30 ? 85 : rsi >= 70 ? 15 : 50 - (rsi - 50) * 0.6),
  };
}

function opportunityScoreRaw(confidence: number, risk: number, contextScore: number): number {
  return Math.round(confidence * 0.55 + (100 - risk) * 0.25 + contextScore * 0.20);
}

function buildConfidenceComponents(breakdown: ConfidenceBreakdown): Record<string, number> {
  return {
    factor_alignment:  breakdown.trendScore,
    strategy_clarity:  breakdown.structureScore,
    regime_alignment:  breakdown.contextScore,
    liquidity_quality: breakdown.volumeScore,
    data_quality:      100,
    portfolio_fit:     50,
    participation:     breakdown.volumeScore,
    rr_quality:        breakdown.momentumScore,
    volatility_fit:    breakdown.structureScore,
  };
}

function buildFromCandidate(
  instrument_key: string,
  tradingsymbol: string,
  exchange: string,
  best: StrategyCandidate,
  regimeLabel: MarketRegimeLabel,
): Signal {
  const direction    = strategyDirection(best.strategy);
  const contextScore = computeContextScore(regimeLabel);
  const confidence   = Math.round(best.confidence.finalScore);
  const riskScore    = Math.round(best.risk.totalScore);
  const rewardRisk   = best.tradePlan.rewardRiskApprox;

  // ── Phase-4 scoring (calculateFinalScore + 6-band) ────────────
  // Same adapter the batch path calls — guarantees identical fields
  // across live and batch outputs.
  const phase4 = runPhase4Scoring({
    strategyQuality:    best.confidence.finalScore,
    trendAlignment:     best.confidence.trendScore,
    momentum:           best.confidence.momentumScore,
    volumeConfirmation: best.confidence.volumeScore,
    liquidity:          null,                            // derived from volumeVs20dAvg
    marketRegime:       contextScore,
    portfolioFit:       50,                              // live has no portfolio context
    riskRewardRatio:    rewardRisk,
    volumeVs20dAvg:     best.features.volume.volumeVs20dAvg ?? null,
    atrPct:             best.features.volatility.atrPct ?? null,
    manipulationScore:  null,
    ageBars:            0,
    upstreamStatus:     'APPROVED_SIGNAL',
  });

  return {
    instrument_key, tradingsymbol, exchange,
    direction,
    timeframe:         'swing',
    confidence,
    risk_score:        riskScore,
    opportunity_score: opportunityScoreRaw(confidence, riskScore, contextScore),
    portfolio_fit:     50,
    conviction_band:   mapConfidenceBand(best.confidence.band),
    market_stance:     'selective',
    regime_alignment:  Math.round(contextScore),
    rejection_reasons: [],
    rejection_codes:   [],
    signal_status:     'APPROVED_SIGNAL',
    final_score:       phase4.final_score,
    classification:    phase4.classification,
    factor_scores_phase4: phase4.factor_scores,
    soft_warnings:     best.warnings,
    blocked_by: {
      risk: false, portfolio: false, scenario: false,
      liquidity: false, data_quality: false, stance: false, regime: false,
    },
    risk:         mapRiskBand(best.risk.band),
    scenario_tag: STRATEGY_TO_SCENARIO[best.strategy],
    regime:       mapRegimeLabel(regimeLabel),
    entry_price:  best.tradePlan.entry.zoneHigh,
    stop_loss:    best.tradePlan.stopLoss,
    target1:      best.tradePlan.targets.target1,
    target2:      best.tradePlan.targets.target2,
    risk_reward:  best.tradePlan.rewardRiskApprox,
    factor_scores: deriveFactorScores(best.features),
    confidence_components: buildConfidenceComponents(best.confidence),
    reasons: best.reasons.map((text, i) => ({
      rank:         i + 1,
      factor_key:   null,
      text,
      contribution: 0,
    })),
    data_quality: 80,
    generated_at: new Date().toISOString(),
    score_raw:    best.confidence.finalScore / 100,
  };
}

function buildRejection(
  instrument_key: string,
  tradingsymbol: string,
  exchange: string,
  reasons: string[],
  regimeLabel: MarketRegimeLabel | null,
  codes: string[] = ['NO_MATCH'],
  signalStatus: SignalStatus = 'NO_TRADE',
  confidence: number = 0,
): Signal {
  // Phase-4 scoring for rejected rows. upstreamStatus carries the
  // tri-state through to the final classification — calculateFinalScore
  // is purely score-based, so without the override a rejected row
  // could still come back as VALID_SIGNAL on raw factor strength.
  const phase4 = runPhase4Scoring({
    strategyQuality:    confidence,
    trendAlignment:     null,
    momentum:           null,
    volumeConfirmation: null,
    liquidity:          null,
    marketRegime:       null,
    portfolioFit:       null,
    riskRewardRatio:    0,
    volumeVs20dAvg:     null,
    atrPct:             null,
    manipulationScore:  null,
    ageBars:            0,
    upstreamStatus:     signalStatus,
  });

  return {
    instrument_key, tradingsymbol, exchange,
    direction:         'HOLD',
    timeframe:         'swing',
    confidence,
    risk_score:        50,
    opportunity_score: 0,
    portfolio_fit:     0,
    conviction_band:   'reject',
    market_stance:     'capital_preservation',
    regime_alignment:  0,
    rejection_reasons: reasons,
    rejection_codes:   codes,
    signal_status:     signalStatus,
    final_score:       phase4.final_score,
    classification:    phase4.classification,
    factor_scores_phase4: phase4.factor_scores,
    soft_warnings:     [],
    blocked_by: {
      risk: false, portfolio: false, scenario: true,
      liquidity: false, data_quality: false, stance: false, regime: false,
    },
    risk:         'High',
    scenario_tag: 'NO_STRATEGY',
    regime:       regimeLabel ? mapRegimeLabel(regimeLabel) : 'NEUTRAL',
    entry_price:  0,
    stop_loss:    0,
    target1:      0,
    target2:      0,
    risk_reward:  0,
    factor_scores: {
      momentum: 0, trend_quality: 0, volatility: 0, liquidity: 0,
      participation: 0, relative_strength: 0, breakout_readiness: 0, mean_reversion: 0,
    },
    confidence_components: {},
    reasons:      [],
    data_quality: 50,
    generated_at: new Date().toISOString(),
    score_raw:    0,
  };
}

// ════════════════════════════════════════════════════════════════
//  PUBLIC API
// ════════════════════════════════════════════════════════════════

export async function generateSignal(
  instrument_key: string,
  tradingsymbol:  string,
  exchange:       string,
): Promise<Signal | null> {
  const t0 = Date.now();
  console.log(`[SignalEngine] ▶ generateSignal  sym=${tradingsymbol}  key=${instrument_key}`);
  try {
    const benchmark = await getBenchmarkSnapshot();
    if (!benchmark) {
      console.warn(`[SignalEngine] ${tradingsymbol} ABORT — benchmark snapshot unavailable`);
      return null;
    }
    console.log(`[SignalEngine] ${tradingsymbol} benchmark regime=${benchmark.regime.label}`);

    const candles = await fetchDailyCandles(tradingsymbol);
    console.log(`[SignalEngine] ${tradingsymbol} candles=${candles.length} (min=${DEFAULT_PHASE1_CONFIG.minCandleCount})`);

    // ── Stale-candle rejection (Phase-5 rule) ─────────────────
    // Data older than 3 calendar days (≈ 1 weekend + 1 trading
    // day) means the pipeline is scoring off stale ticks. Reject
    // as NO_TRADE with a clear reason rather than emit a
    // signal whose trade plan references a week-old close.
    const STALE_CANDLE_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
    const newest = candles[candles.length - 1];
    if (newest) {
      const newestTs = new Date(newest.ts as any).getTime();
      if (Number.isFinite(newestTs)) {
        const ageMs = Date.now() - newestTs;
        if (ageMs > STALE_CANDLE_MAX_AGE_MS) {
          const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1);
          console.warn(
            `[SignalEngine] ${tradingsymbol} REJECTED — stale candle ` +
            `(newest=${ageDays}d old, max=${STALE_CANDLE_MAX_AGE_MS / (24 * 60 * 60 * 1000)}d)`
          );
          return buildRejection(
            instrument_key, tradingsymbol, exchange,
            [`Stale candle data: newest close is ${ageDays} days old`],
            benchmark.regime.label,
            ['stale_candle'], 'NO_TRADE',
          );
        }
      }
    }

    if (candles.length < DEFAULT_PHASE1_CONFIG.minCandleCount) {
      console.warn(`[SignalEngine] ${tradingsymbol} ABORT — insufficient candles`);
      return null;
    }

    const features = buildSignalFeatures(
      candles,
      benchmark.regime.label,
      DEFAULT_PHASE1_CONFIG.minAvgVolume,
      DEFAULT_PHASE1_CONFIG.minPrice,
    );
    console.log(
      `[SignalEngine] ${tradingsymbol} features  ` +
      `close=${features.trend.close} rsi=${features.momentum.rsi14?.toFixed?.(1) ?? features.momentum.rsi14} ` +
      `ema20>ema50=${features.trend.ema20Above50} ema50>ema200=${features.trend.ema50Above200} ` +
      `volRatio=${features.volume.volumeVs20dAvg?.toFixed?.(2)} atrPct=${features.volatility.atrPct?.toFixed?.(2)} ` +
      `liq=${features.context.liquidityPass}`
    );

    const rs     = computeRelativeStrength(candles, benchmark.candles);
    console.log(
      `[SignalEngine] ${tradingsymbol} RS  ` +
      `vsIndex=${rs.rsVsIndex.toFixed(2)}  ` +
      `vsSector=${rs.rsVsSector.toFixed(2)}  ` +
      `sectorStrength=${rs.sectorStrengthScore.toFixed(1)}`
    );

    const result = runAllStrategies(features, rs);
    console.log(
      `[SignalEngine] ${tradingsymbol} strategies  ` +
      `candidates=${result.candidates.length}  rejections=${result.rejections.length}`
    );
    for (const r of result.rejections.slice(0, 8)) {
      console.log(`[SignalEngine] ${tradingsymbol}   ✗ ${r.strategy}: ${r.reason}`);
    }
    for (const c of result.candidates.slice(0, 5)) {
      console.log(`[SignalEngine] ${tradingsymbol}   ✓ ${c.strategy}  conf=${Math.round(c.confidence.finalScore)}  band=${c.confidence.band}`);
    }

    if (result.candidates.length === 0) {
      const topReason = result.rejections[0]
        ? `${result.rejections[0].strategy}: ${result.rejections[0].reason}`
        : 'No strategy matched';
      console.log(`[SignalEngine] ${tradingsymbol} DEVELOPING (no candidates) — ${topReason}  ${Date.now() - t0}ms`);
      return buildRejection(
        instrument_key, tradingsymbol, exchange,
        [topReason], benchmark.regime.label,
        ['no_strategy'], 'DEVELOPING_SETUP',
      );
    }

    const best = result.candidates[0];
    const bestConf = Math.round(best.confidence.finalScore);

    if (best.confidence.finalScore < DEFAULT_PHASE1_CONFIG.minConfidenceToSave) {
      const status = classifySignalStatus({
        finalDecision:   'rejected',
        rejectionCode:   'confidence_below_threshold',
        confidenceScore: best.confidence.finalScore,
        minConfidence:   DEFAULT_PHASE1_CONFIG.minConfidenceToSave,
      });
      console.log(
        `[SignalEngine] ${tradingsymbol} ${status} — ${best.strategy} conf=${bestConf} ` +
        `< minToSave=${DEFAULT_PHASE1_CONFIG.minConfidenceToSave}  ${Date.now() - t0}ms`
      );
      return buildRejection(
        instrument_key, tradingsymbol, exchange,
        [`Confidence too low: ${bestConf}`],
        benchmark.regime.label,
        ['confidence_below_threshold'], status, bestConf,
      );
    }

    // ── Full canonical rejection engine ──────────────────────────
    // Live path previously stopped at the confidence gate. That
    // bypassed R:R, liquidity, stop-distance, regime-compat, risk-
    // score-cap, portfolio-fit and manipulation checks that the
    // batch pipeline applies via runRejectionEngine. Live now runs
    // the same engine so Signal Intelligence reflects the same
    // gates end-to-end.
    //
    // Live has no portfolio context, so we pass a neutral
    // PortfolioFitResult that the engine treats as a pass. Gates
    // that depend on external context (scenario, stance,
    // manipulation) are omitted — the engine skips them when the
    // context is absent.
    const neutralPortfolioFit: PortfolioFitResult = {
      fitScore:            70,
      sectorExposureImpact:'acceptable',
      directionImpact:     'acceptable',
      capitalAvailability: 'sufficient',
      correlationCluster:  null,
      correlationPenalty:  0,
      portfolioDecision:   'approved',
      penalties:           [],
    };
    const neutralExecutionReadiness: ExecutionReadiness = {
      status:            'ready',
      actionTag:         'enter_now',
      priorityRank:      null,
      approvalDecision:  'approved',
      reasons:           [],
    };

    // ── Manipulation risk (Gate 8) ─────────────────────────────
    // Lazy-import matches the Phase 3 batch pattern: if the
    // manipulation engine is unavailable we continue without
    // penalty rather than aborting. When the snapshot exists and
    // crosses the penalty threshold, we decrement confidence by
    // the suggested penalty so the confidence gate downstream can
    // still catch it.
    let manipulationContext: RejectionInput['manipulationContext'] = undefined;
    try {
      const { getManipulationStatusForSymbol } = await import('@/lib/manipulation-engine/api/signalEngineHooks');
      const manipStatus = await getManipulationStatusForSymbol(tradingsymbol);
      if (manipStatus.score > 0) {
        manipulationContext = {
          score:          manipStatus.score,
          band:           manipStatus.band,
          shouldPenalize: manipStatus.shouldPenalize,
          shouldReject:   manipStatus.shouldReject,
          warning:        manipStatus.warning,
        };
        if (manipStatus.shouldPenalize && !manipStatus.shouldReject) {
          best.confidence = {
            ...best.confidence,
            finalScore: Math.max(0, best.confidence.finalScore - manipStatus.suggestedPenalty),
          };
        }
      }
    } catch { /* manipulation engine unavailable — continue without penalty */ }

    // Phase-5 stricter thresholds: the engine's defaults (55 / 1.5
    // / 80) are too loose vs the signals-table spec (60 / 1.5 /
    // 70). Force the stricter values via stanceContext so
    // confidence < 60, R:R < 1.5, and risk_score > 70 each trigger
    // a rejection regardless of the engine's fallback defaults.
    const strictStanceContext: RejectionInput['stanceContext'] = {
      stance:        'selective',
      conviction:    'medium',
      riskMode:      'strict',
      minConfidence: 60,
      minRR:         1.5,
      maxRiskScore:  70,
    };

    // ── Phase-5 ORDER: scoring FIRST, then rejection ───────────
    // Compute Phase-4 factor scores up front so the rejection engine
    // can read `liquidity_score` (and other Phase-4 outputs) from
    // them. Without this, the Phase-5 numeric gates would have no
    // 0-100 liquidity score to evaluate.
    const livePhase4 = runPhase4Scoring({
      strategyQuality:    best.confidence.finalScore,
      trendAlignment:     best.confidence.trendScore,
      momentum:           best.confidence.momentumScore,
      volumeConfirmation: best.confidence.volumeScore,
      liquidity:          null,
      marketRegime:       computeContextScore(benchmark.regime.label),
      portfolioFit:       50,                                 // live has no portfolio context
      riskRewardRatio:    best.tradePlan.rewardRiskApprox,
      volumeVs20dAvg:     best.features.volume.volumeVs20dAvg ?? null,
      atrPct:             best.features.volatility.atrPct ?? null,
      manipulationScore:  manipulationContext?.score ?? null,
      ageBars:            0,
    });

    const liveDirection: 'BUY' | 'SELL' = strategyDirection(best.strategy) === 'SELL' ? 'SELL' : 'BUY';

    const rejectionInput: RejectionInput = {
      symbol:             tradingsymbol,
      strategy:           best.strategy,
      confidenceScore:    best.confidence.finalScore,
      riskScore:          best.risk.totalScore,
      rewardRisk:         best.tradePlan.rewardRiskApprox,
      entryPrice:         best.tradePlan.entry.zoneHigh,
      stopLoss:           best.tradePlan.stopLoss,
      atrPct:             features.volatility.atrPct ?? 0,
      volume:             features.volume.volume ?? 0,
      regime:             benchmark.regime.label,
      sector:             'UNKNOWN',
      portfolioFit:       neutralPortfolioFit,
      executionReadiness: neutralExecutionReadiness,
      manipulationContext,
      stanceContext:      strictStanceContext,
      // Activate the staleness gate. At generation time the signal is
      // 0h old so this is a trivial pass, but the field records age in
      // the audit snapshot and arms the gate for any future caller
      // that re-runs this input with a back-dated generatedAt
      // (replay, backfill, rescore-on-demand).
      generatedAt:        new Date().toISOString(),
      // ── Phase-5 inputs ──────────────────────────────────────
      liquidityScore:     livePhase4.factor_scores.liquidity,
      minLiquidityScore:  50,
      minPortfolioFit:    50,
      maxManipulationRisk: 60,
      decayState:         'fresh',
      liveInvalidated:    false,
      currentPrice:       null,                  // live LTP enrichment is API-layer concern
      direction:          liveDirection,
    };
    const decision = runRejectionEngine(rejectionInput);
    console.log(
      `[SignalEngine] ${tradingsymbol} rejection=${decision.finalDecision} ` +
      `status=${decision.signalStatus} code=${decision.rejectionCode ?? 'none'}`
    );

    if (decision.finalDecision === 'rejected') {
      const reasons = [
        decision.rejectionMessage ?? 'Rejected by risk gate',
        ...decision.appliedRules.filter((g) => !g.passed && g.message).map((g) => g.message!),
      ];
      const codes = [
        ...(decision.rejectionCode ? [decision.rejectionCode] : []),
        ...decision.appliedRules.filter((g) => !g.passed && g.code).map((g) => g.code!),
      ];
      console.log(
        `[SignalEngine] ${tradingsymbol} ${decision.signalStatus} — ${decision.rejectionCode}  ${Date.now() - t0}ms`
      );
      return buildRejection(
        instrument_key, tradingsymbol, exchange,
        reasons, benchmark.regime.label,
        Array.from(new Set(codes)), decision.signalStatus, bestConf,
      );
    }

    console.log(
      `[SignalEngine] ${tradingsymbol} APPROVED — ${best.strategy}  conf=${bestConf} ` +
      `band=${best.confidence.band}  ${Date.now() - t0}ms`
    );
    return buildFromCandidate(instrument_key, tradingsymbol, exchange, best, benchmark.regime.label);
  } catch (err) {
    console.error(`[SignalEngine] ${tradingsymbol} EXCEPTION  ${(err as Error).message}`);
    return null;
  }
}

export function opportunityScore(signal: Signal): number {
  return signal.opportunity_score;
}

export async function persistSignal(signal: Signal): Promise<void> {
  try {
    await db.query(
      `INSERT INTO signals
         (instrument_key, tradingsymbol, signal_type, strength, description,
          confidence, risk_score, scenario_tag, regime,
          confidence_score, market_stance, conviction_band,
          portfolio_fit_score, generated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        signal.instrument_key,
        signal.tradingsymbol,
        signal.direction,
        signal.confidence >= 75 ? 'Strong' : signal.confidence >= 55 ? 'Moderate' : 'Weak',
        signal.reasons.slice(0, 3).map((r) => r.text).join('; '),
        signal.confidence,
        signal.risk_score,
        signal.scenario_tag,
        signal.regime,
        signal.confidence,
        signal.market_stance,
        signal.conviction_band,
        signal.portfolio_fit,
      ],
    );
  } catch {}
}

export async function logRejection(
  instrumentKey: string,
  tradingsymbol: string,
  reasons:       string[],
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO signal_quality_events
         (instrument_key, tradingsymbol, event_type, details, created_at)
       VALUES (?, ?, 'REJECTED', ?, NOW())`,
      [instrumentKey, tradingsymbol, reasons.join(' | ')],
    );
  } catch {}
}

export async function generateSignalsForWatchlist(
  items: Array<{ instrument_key: string; tradingsymbol: string; exchange: string }>,
): Promise<Signal[]> {
  const BATCH = 5;
  const results: Signal[] = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    const sigs  = await Promise.all(
      chunk.map((item) =>
        generateSignal(item.instrument_key, item.tradingsymbol, item.exchange).catch(() => null),
      ),
    );
    for (const sig of sigs) if (sig) results.push(sig);
  }
  const bySymbol = new Map<string, Signal>();
  for (const s of results) {
    if (s.rejection_reasons.length > 0) continue;
    const existing = bySymbol.get(s.tradingsymbol);
    if (!existing || s.opportunity_score > existing.opportunity_score) {
      bySymbol.set(s.tradingsymbol, s);
    }
  }
  return Array.from(bySymbol.values()).sort((a, b) => b.opportunity_score - a.opportunity_score);
}
