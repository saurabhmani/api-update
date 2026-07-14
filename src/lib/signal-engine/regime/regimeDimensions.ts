// ════════════════════════════════════════════════════════════════
//  Regime Dimension Classification — Product A Phase 3
// ════════════════════════════════════════════════════════════════

import type {
  MarketRegimeLabel,
  RegimeDimensions,
  RegimeEvidenceBreakdown,
  RegimeTrendState,
  RegimeVolatilityState,
  RegimeBreadthState,
  RegimeLiquidityState,
  RegimeTransitionState,
} from '../types/signalEngine.types';

/** Map structured trend_state → legacy human-readable label (compat). */
export function labelFromTrendAndVol(
  trend: RegimeTrendState,
  vol: RegimeVolatilityState,
): MarketRegimeLabel {
  if (vol === 'extreme') return 'High Volatility Risk';
  switch (trend) {
    case 'strong_bull': return 'Strong Bullish';
    case 'bull': return 'Bullish';
    case 'strong_bear': return 'Bearish';
    case 'bear': return 'Weak';
    default: return 'Sideways';
  }
}

export function trendStateFromLabel(label: MarketRegimeLabel): RegimeTrendState {
  switch (label) {
    case 'Strong Bullish': return 'strong_bull';
    case 'Bullish': return 'bull';
    case 'Bearish': return 'strong_bear';
    case 'Weak': return 'bear';
    case 'High Volatility Risk': return 'neutral';
    default: return 'neutral';
  }
}

export function volatilityLabelFromState(
  state: RegimeVolatilityState,
): 'Low' | 'Normal' | 'Elevated' | 'Extreme' {
  switch (state) {
    case 'compressed': return 'Low';
    case 'elevated': return 'Elevated';
    case 'extreme': return 'Extreme';
    default: return 'Normal';
  }
}

/**
 * Classify trend from EMA stack / slope / ADX / RSI.
 * Uses entry-biased thresholds; hysteresis applies separately.
 */
export function classifyTrendState(e: RegimeEvidenceBreakdown): RegimeTrendState {
  const stackedBull =
    e.closeVsEma20 > 0 && e.closeVsEma50 > 0 && e.closeVsEma200 > 0 &&
    e.ema20VsEma50 > 0 && e.ema50VsEma200 > 0;
  const stackedBear =
    e.closeVsEma20 < 0 && e.closeVsEma50 < 0 && e.closeVsEma200 < 0 &&
    e.ema20VsEma50 < 0;

  const adxStrong = e.adx != null && e.adx >= 25;
  const adxWeak = e.adx != null && e.adx < 18;

  if (stackedBull && e.rsi >= 55 && e.rsi <= 75 && e.ema20SlopePct > 0.15 && (adxStrong || e.adx == null)) {
    return 'strong_bull';
  }
  if (e.closeVsEma20 > 0 && e.closeVsEma50 > 0 && e.ema20VsEma50 > 0 && e.rsi >= 50) {
    return 'bull';
  }
  if (stackedBear && e.rsi <= 45 && e.ema20SlopePct < -0.15) {
    return 'strong_bear';
  }
  if (e.closeVsEma20 < 0 && e.closeVsEma50 < 0 && e.rsi < 45) {
    return 'bear';
  }
  if (adxWeak && Math.abs(e.ema20SlopePct) < 0.1) {
    return 'neutral';
  }
  return 'neutral';
}

/** Prefer ATR percentile when available; fall back to absolute ATR%. */
export function classifyVolatilityState(e: RegimeEvidenceBreakdown): RegimeVolatilityState {
  if (e.atrPercentile != null) {
    if (e.atrPercentile >= 90 || e.atrPct > 3.5) return 'extreme';
    if (e.atrPercentile >= 70 || e.atrPct > 2.5) return 'elevated';
    if (e.atrPercentile <= 25 && e.atrPct < 1.2) return 'compressed';
    return 'normal';
  }
  if (e.atrPct > 3.0) return 'extreme';
  if (e.atrPct > 2.0) return 'elevated';
  if (e.atrPct < 1.0) return 'compressed';
  return 'normal';
}

export function classifyBreadthState(e: RegimeEvidenceBreakdown): RegimeBreadthState {
  const ad = e.advanceDeclineRatio;
  const pct20 = e.pctAboveEma20;
  const nhl = e.newHighsVsLows;

  if (ad == null && pct20 == null && nhl == null) {
    // Benchmark-only proxy — never claim universe breadth
    if (e.closeVsEma50 > 1 && e.ema20SlopePct > 0.1) return 'selective';
    if (e.closeVsEma50 < -1 && e.ema20SlopePct < -0.1) return 'deteriorating';
    return 'selective';
  }

  const adv = ad ?? 1;
  const above = pct20 ?? 50;
  const nhlScore = nhl ?? 0;

  if (adv < 0.4 || above < 20 || nhlScore < -0.5) return 'capitulation';
  if (adv < 0.8 || above < 40 || nhlScore < 0) return 'deteriorating';
  if (adv >= 1.5 && above >= 60 && nhlScore >= 0) return 'broad_participation';
  return 'selective';
}

export function classifyLiquidityState(e: RegimeEvidenceBreakdown): RegimeLiquidityState {
  // Benchmark gap / vol proxy for market liquidity stress
  if (e.recentGapAbsPctAvg >= 1.5 || e.atrPct >= 3.5) return 'stressed';
  if (e.recentGapAbsPctAvg >= 0.8 || Math.abs(e.gapPct) >= 1.2) return 'thin';
  return 'healthy';
}

export function classifyTransitionState(
  e: RegimeEvidenceBreakdown,
  previousTrend: RegimeTrendState | null,
  currentTrend: RegimeTrendState,
): RegimeTransitionState {
  if (previousTrend == null) return 'emerging';

  const bullish = (t: RegimeTrendState) => t === 'bull' || t === 'strong_bull';
  const bearish = (t: RegimeTrendState) => t === 'bear' || t === 'strong_bear';

  if (previousTrend === currentTrend) {
    if (e.adx != null && e.adx < 18) return 'weakening';
    return 'stable';
  }

  if (
    (bullish(previousTrend) && bearish(currentTrend)) ||
    (bearish(previousTrend) && bullish(currentTrend))
  ) {
    return 'reversal_risk';
  }

  if (previousTrend === 'neutral' && currentTrend !== 'neutral') return 'emerging';
  if (currentTrend === 'neutral' && previousTrend !== 'neutral') return 'weakening';
  return 'emerging';
}

export function classifyAllDimensions(
  e: RegimeEvidenceBreakdown,
  previousTrend: RegimeTrendState | null = null,
): RegimeDimensions {
  const trend_state = classifyTrendState(e);
  const volatility_state = classifyVolatilityState(e);
  const breadth_state = classifyBreadthState(e);
  const liquidity_state = classifyLiquidityState(e);
  const transition_state = classifyTransitionState(e, previousTrend, trend_state);
  return { trend_state, volatility_state, breadth_state, liquidity_state, transition_state };
}
