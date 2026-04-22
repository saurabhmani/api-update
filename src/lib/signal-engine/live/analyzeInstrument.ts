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
}

const BENCHMARK_TTL_MS = 60_000;
let benchmarkCache: BenchmarkSnapshot | null = null;

async function getBenchmarkSnapshot(): Promise<BenchmarkSnapshot | null> {
  const now = Date.now();
  if (benchmarkCache && now - benchmarkCache.fetchedAt < BENCHMARK_TTL_MS) {
    return benchmarkCache;
  }
  try {
    const candles = await fetchDailyCandles(DEFAULT_PHASE1_CONFIG.benchmarkSymbol);
    if (candles.length < DEFAULT_PHASE1_CONFIG.minCandleCount) return null;
    const regime = detectMarketRegime(candles);
    benchmarkCache = { candles, regime, fetchedAt: now };
    return benchmarkCache;
  } catch {
    return null;
  }
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
): Signal {
  return {
    instrument_key, tradingsymbol, exchange,
    direction:         'HOLD',
    timeframe:         'swing',
    confidence:        0,
    risk_score:        50,
    opportunity_score: 0,
    portfolio_fit:     0,
    conviction_band:   'reject',
    market_stance:     'capital_preservation',
    regime_alignment:  0,
    rejection_reasons: reasons,
    rejection_codes:   ['NO_MATCH'],
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
      console.log(`[SignalEngine] ${tradingsymbol} REJECTED (no candidates) — ${topReason}  ${Date.now() - t0}ms`);
      return buildRejection(instrument_key, tradingsymbol, exchange, [topReason], benchmark.regime.label);
    }

    const best = result.candidates[0];
    if (best.confidence.finalScore < DEFAULT_PHASE1_CONFIG.minConfidenceToSave) {
      console.log(
        `[SignalEngine] ${tradingsymbol} REJECTED — ${best.strategy} conf=${Math.round(best.confidence.finalScore)} ` +
        `< minToSave=${DEFAULT_PHASE1_CONFIG.minConfidenceToSave}  ${Date.now() - t0}ms`
      );
      return buildRejection(
        instrument_key, tradingsymbol, exchange,
        [`Confidence too low: ${Math.round(best.confidence.finalScore)}`],
        benchmark.regime.label,
      );
    }

    console.log(
      `[SignalEngine] ${tradingsymbol} APPROVED — ${best.strategy}  conf=${Math.round(best.confidence.finalScore)} ` +
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
