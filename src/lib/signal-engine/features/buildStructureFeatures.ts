// ════════════════════════════════════════════════════════════════
//  Structure Feature Builder
// ════════════════════════════════════════════════════════════════

import type { StructureFeatures, Candle } from '../types/signalEngine.types';
import { highs, lows, lastCandle } from '../utils/candles';
import { round, pctChange, safeDivide } from '../utils/math';
import { STRUCTURE_LOOKBACK } from '../constants/signalEngine.constants';

export function buildStructureFeatures(candles: Candle[]): StructureFeatures {
  const current = lastCandle(candles);
  const len = candles.length;

  // Lookback excludes the current candle
  const lookbackStart = Math.max(0, len - STRUCTURE_LOOKBACK - 1);
  const lookbackEnd = len - 1;
  const lookbackCandles = candles.slice(lookbackStart, lookbackEnd);

  // Guard: ensure lookback has at least 1 candle
  if (lookbackCandles.length === 0) {
    return {
      recentResistance20: round(current.high),
      recentSupport20: round(current.low),
      breakoutDistancePct: 0,
      distanceToResistancePct: 0,
      distanceToSupportPct: 0,
      recentHigh20: round(current.high),
      recentLow20: round(current.low),
      isInsideDay: false,
      rangeCompressionRatio: 1,
      consecutiveHigherLows: 0,
      consecutiveLowerHighs: 0,
    };
  }

  const lookbackHighs = highs(lookbackCandles);
  const lookbackLows = lows(lookbackCandles);

  const recentHigh20 = Math.max(...lookbackHighs);
  const recentLow20 = Math.min(...lookbackLows);

  const recentResistance20 = recentHigh20;
  const recentSupport20 = recentLow20;

  const breakoutDistancePct = pctChange(current.close, recentResistance20);
  const distanceToResistancePct = pctChange(recentResistance20, current.close);
  const distanceToSupportPct = pctChange(current.close, recentSupport20);

  // Inside day: current candle range is entirely within previous candle
  const prev = candles[len - 2];
  const isInsideDay = prev
    ? current.high <= prev.high && current.low >= prev.low
    : false;

  // Range compression: compare current range to average lookback range
  const avgRange = lookbackCandles.reduce((s, c) => s + (c.high - c.low), 0) / lookbackCandles.length;
  const currentRange = current.high - current.low;
  const rangeCompressionRatio = round(safeDivide(currentRange, avgRange), 2);

  // Consecutive higher lows (bullish structure)
  let consecutiveHigherLows = 0;
  for (let i = candles.length - 2; i > 0; i--) {
    if (candles[i].low > candles[i - 1].low) consecutiveHigherLows++;
    else break;
  }

  // Consecutive lower highs (bearish structure)
  let consecutiveLowerHighs = 0;
  for (let i = candles.length - 2; i > 0; i--) {
    if (candles[i].high < candles[i - 1].high) consecutiveLowerHighs++;
    else break;
  }

  return {
    recentResistance20: round(recentResistance20),
    recentSupport20: round(recentSupport20),
    breakoutDistancePct: round(breakoutDistancePct),
    distanceToResistancePct: round(distanceToResistancePct),
    distanceToSupportPct: round(distanceToSupportPct),
    recentHigh20: round(recentHigh20),
    recentLow20: round(recentLow20),
    isInsideDay,
    rangeCompressionRatio,
    consecutiveHigherLows: Math.min(consecutiveHigherLows, 10),
    consecutiveLowerHighs: Math.min(consecutiveLowerHighs, 10),
  };
}
