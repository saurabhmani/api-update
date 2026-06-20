// ════════════════════════════════════════════════════════════════
//  Structure Feature Builder
// ════════════════════════════════════════════════════════════════

import type { StructureFeatures, Candle } from '../types/signalEngine.types';
import {
  calculateFibonacciLevels,
  findNearestFibLevel,
  isPriceNearFibLevel,
  type FibonacciLevels,
} from '../indicators/fibonacci';
import { highs, lows, lastCandle } from '../utils/candles';
import { round, pctChange, safeDivide } from '../utils/math';
import { STRUCTURE_LOOKBACK } from '../constants/signalEngine.constants';

/** Golden-zone proximity tolerance (%). Increase to 1.5 for wider matching. */
const FIB_ZONE_TOLERANCE_PCT = 1;

const FIB_LEVEL_KEYS: (keyof FibonacciLevels)[] = [
  'fib236',
  'fib382',
  'fib50',
  'fib618',
  'fib786',
  'fib100',
  'fib1272',
  'fib1618',
];

function buildFibonacciStructureFeatures(
  swingHigh: number,
  swingLow: number,
  close: number,
): Pick<
  StructureFeatures,
  | 'fib236'
  | 'fib382'
  | 'fib50'
  | 'fib618'
  | 'fib786'
  | 'fib100'
  | 'fib1272'
  | 'fib1618'
  | 'fibNearestLevel'
  | 'fibNearestLevelName'
  | 'fibDistancePct'
  | 'fibZoneMatched'
> {
  try {
    const levels = calculateFibonacciLevels(swingHigh, swingLow);
    const hasValidLevel = FIB_LEVEL_KEYS.some((key) => levels[key] !== null);
    if (!hasValidLevel) {
      return {};
    }

    const features: Pick<
      StructureFeatures,
      | 'fib236'
      | 'fib382'
      | 'fib50'
      | 'fib618'
      | 'fib786'
      | 'fib100'
      | 'fib1272'
      | 'fib1618'
      | 'fibNearestLevel'
      | 'fibNearestLevelName'
      | 'fibDistancePct'
      | 'fibZoneMatched'
    > = {};

    for (const key of FIB_LEVEL_KEYS) {
      const value = levels[key];
      if (value !== null) {
        features[key] = round(value);
      }
    }

    const nearest = findNearestFibLevel(close, levels);
    if (nearest) {
      features.fibNearestLevel = round(nearest.value);
      features.fibNearestLevelName = nearest.name;
      features.fibDistancePct = round(Math.abs(pctChange(close, nearest.value)));
    }

    const { fib382, fib50, fib618 } = levels;
    features.fibZoneMatched =
      (fib382 !== null && isPriceNearFibLevel(close, fib382, FIB_ZONE_TOLERANCE_PCT))
      || (fib50 !== null && isPriceNearFibLevel(close, fib50, FIB_ZONE_TOLERANCE_PCT))
      || (fib618 !== null && isPriceNearFibLevel(close, fib618, FIB_ZONE_TOLERANCE_PCT));

    return features;
  } catch {
    return {};
  }
}

export function buildStructureFeatures(candles: Candle[]): StructureFeatures {
  const current = lastCandle(candles);
  const len = candles.length;

  // Lookback excludes the current candle
  const lookbackStart = Math.max(0, len - STRUCTURE_LOOKBACK - 1);
  const lookbackEnd = len - 1;
  const lookbackCandles = candles.slice(lookbackStart, lookbackEnd);

  // Guard: ensure lookback has at least 1 candle
  if (lookbackCandles.length === 0) {
    const recentHigh20 = round(current.high);
    const recentLow20 = round(current.low);
    const recentResistance20 = recentHigh20;
    const recentSupport20 = recentLow20;

    return {
      recentResistance20,
      recentSupport20,
      breakoutDistancePct: 0,
      distanceToResistancePct: 0,
      distanceToSupportPct: 0,
      recentHigh20,
      recentLow20,
      isInsideDay: false,
      rangeCompressionRatio: 1,
      consecutiveHigherLows: 0,
      consecutiveLowerHighs: 0,
      ...buildFibonacciStructureFeatures(
        recentHigh20 ?? recentResistance20,
        recentLow20 ?? recentSupport20,
        current.close,
      ),
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

  const roundedRecentHigh20 = round(recentHigh20);
  const roundedRecentLow20 = round(recentLow20);
  const roundedRecentResistance20 = round(recentResistance20);
  const roundedRecentSupport20 = round(recentSupport20);

  return {
    recentResistance20: roundedRecentResistance20,
    recentSupport20: roundedRecentSupport20,
    breakoutDistancePct: round(breakoutDistancePct),
    distanceToResistancePct: round(distanceToResistancePct),
    distanceToSupportPct: round(distanceToSupportPct),
    recentHigh20: roundedRecentHigh20,
    recentLow20: roundedRecentLow20,
    isInsideDay,
    rangeCompressionRatio,
    consecutiveHigherLows: Math.min(consecutiveHigherLows, 10),
    consecutiveLowerHighs: Math.min(consecutiveLowerHighs, 10),
    ...buildFibonacciStructureFeatures(
      roundedRecentHigh20 ?? roundedRecentResistance20,
      roundedRecentLow20 ?? roundedRecentSupport20,
      current.close,
    ),
  };
}
