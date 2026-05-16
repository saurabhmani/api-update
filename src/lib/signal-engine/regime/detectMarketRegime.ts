// ════════════════════════════════════════════════════════════════
//  Market Regime Detector
// ════════════════════════════════════════════════════════════════

import type { Candle, MarketRegime, MarketRegimeLabel } from '../types/signalEngine.types';
import { latestEma } from '../indicators/ema';
import { latestRsi } from '../indicators/rsi';
import { latestAtr } from '../indicators/atr';
import { closes, lastCandle } from '../utils/candles';
import { round, safeDivide } from '../utils/math';
import { EMA_FAST, EMA_MID, EMA_SLOW, RSI_PERIOD, ATR_PERIOD } from '../constants/signalEngine.constants';
import { BULLISH_ALLOWED_REGIMES } from '../constants/signalEngine.constants';

import type { EnhancedMarketRegime } from '../types/signalEngine.types';
import { computeEma } from '../indicators/ema';

export function detectEnhancedRegime(benchmarkCandles: Candle[]): EnhancedMarketRegime {
  const base = detectMarketRegime(benchmarkCandles);
  const closePrices = closes(benchmarkCandles);

  // Regime strength (0-100): how many conditions align
  const d = base.details;
  let bullishCount = 0;
  if (d.closeVsEma20 > 0) bullishCount++;
  if (d.closeVsEma50 > 0) bullishCount++;
  if (d.closeVsEma200 > 0) bullishCount++;
  if (d.ema20VsEma50 > 0) bullishCount++;
  if (d.ema50VsEma200 > 0) bullishCount++;
  if (d.rsi >= 50 && d.rsi <= 70) bullishCount++;
  const strength = round(bullishCount / 6 * 100);

  // Volatility regime
  const volatilityRegime = d.atrPct > 3.0 ? 'Extreme' as const
    : d.atrPct > 2.0 ? 'Elevated' as const
    : d.atrPct > 1.0 ? 'Normal' as const
    : 'Low' as const;

  // Trend slope: EMA20 change over last 5 bars
  const emaFull = computeEma(closePrices, EMA_FAST);
  const len = emaFull.length;
  const trendSlope = len >= 6 && !isNaN(emaFull[len - 1]) && !isNaN(emaFull[len - 6])
    ? round(((emaFull[len - 1] - emaFull[len - 6]) / emaFull[len - 6]) * 100, 3)
    : 0;

  // Classification confidence
  const confidence = round(Math.min(100, strength + (base.label.includes('Strong') ? 15 : 0)));

  return { ...base, strength, volatilityRegime, trendSlope, confidence };
}

export function detectMarketRegime(benchmarkCandles: Candle[]): MarketRegime {
  const closePrices = closes(benchmarkCandles);
  const current = lastCandle(benchmarkCandles);

  const ema20 = latestEma(closePrices, EMA_FAST);
  const ema50 = latestEma(closePrices, EMA_MID);
  const ema200 = latestEma(closePrices, EMA_SLOW);
  const rsi = latestRsi(closePrices, RSI_PERIOD);
  const atr = latestAtr(benchmarkCandles, ATR_PERIOD);
  const atrPct = round(safeDivide(atr, current.close) * 100);

  const closeVsEma20 = round(safeDivide(current.close - ema20, ema20) * 100);
  const closeVsEma50 = round(safeDivide(current.close - ema50, ema50) * 100);
  const closeVsEma200 = round(safeDivide(current.close - ema200, ema200) * 100);
  const ema20VsEma50 = round(safeDivide(ema20 - ema50, ema50) * 100);
  const ema50VsEma200 = round(safeDivide(ema50 - ema200, ema200) * 100);

  const details = { closeVsEma20, closeVsEma50, closeVsEma200, ema20VsEma50, ema50VsEma200, rsi: round(rsi), atrPct };

  const label = classifyRegime(details);

  return {
    label,
    allowBullishSignals: (BULLISH_ALLOWED_REGIMES as readonly string[]).includes(label),
    details,
  };
}

function classifyRegime(d: MarketRegime['details']): MarketRegimeLabel {
  // High volatility overrides everything
  if (d.atrPct > 3.0) {
    return 'High Volatility Risk';
  }

  // Strong Bullish: all EMAs aligned, RSI healthy, price above all
  if (
    d.closeVsEma20 > 0 &&
    d.closeVsEma50 > 0 &&
    d.closeVsEma200 > 0 &&
    d.ema20VsEma50 > 0 &&
    d.ema50VsEma200 > 0 &&
    d.rsi >= 55 &&
    d.rsi <= 75
  ) {
    return 'Strong Bullish';
  }

  // Bullish: price above key EMAs with positive structure
  if (
    d.closeVsEma20 > 0 &&
    d.closeVsEma50 > 0 &&
    d.ema20VsEma50 > 0 &&
    d.rsi >= 50
  ) {
    return 'Bullish';
  }

  // Bearish: price below all EMAs, EMAs stacked bearishly
  if (
    d.closeVsEma20 < 0 &&
    d.closeVsEma50 < 0 &&
    d.closeVsEma200 < 0 &&
    d.ema20VsEma50 < 0
  ) {
    return 'Bearish';
  }

  // Weak: price below short-term EMAs, some deterioration
  if (
    d.closeVsEma20 < 0 &&
    d.closeVsEma50 < 0 &&
    d.rsi < 45
  ) {
    return 'Weak';
  }

  // Default: Sideways
  return 'Sideways';
}
