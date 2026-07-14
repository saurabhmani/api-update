// ════════════════════════════════════════════════════════════════
//  Structure Feature Builder — Phase 5 uses confirmed swing anchors
//  for Fibonacci when available (fallback: 20-bar high/low).
// ════════════════════════════════════════════════════════════════

import type { StructureFeatures, Candle } from '../types/signalEngine.types';
import {
  calculateFibonacciLevels,
  findNearestFibLevel,
  isPriceNearFibLevel,
  type FibonacciLevels,
} from '../indicators/fibonacci';
import { selectConfirmedBullishImpulse } from '../structure/confirmedSwingAnchors';
import { scoreFibonacciZoneQuality, fibTolerancePct } from '../structure/fibZoneQuality';
import { latestAtr } from '../indicators/atr';
import { highs, lows, lastCandle } from '../utils/candles';
import { round, pctChange, safeDivide } from '../utils/math';
import { STRUCTURE_LOOKBACK } from '../constants/signalEngine.constants';

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
  tolerancePct: number,
  extras?: Partial<StructureFeatures>,
): Partial<StructureFeatures> {
  try {
    const levels = calculateFibonacciLevels(swingHigh, swingLow);
    const hasValidLevel = FIB_LEVEL_KEYS.some((key) => levels[key] !== null);
    if (!hasValidLevel) {
      return { ...extras };
    }

    const features: Partial<StructureFeatures> = { ...extras };

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

    const { fib382, fib50, fib618, fib786 } = levels;
    features.fibZoneMatched =
      (fib382 !== null && isPriceNearFibLevel(close, fib382, tolerancePct))
      || (fib50 !== null && isPriceNearFibLevel(close, fib50, tolerancePct))
      || (fib618 !== null && isPriceNearFibLevel(close, fib618, tolerancePct))
      || (fib786 !== null && isPriceNearFibLevel(close, fib786, tolerancePct));

    features.fibTolerancePct = tolerancePct;
    return features;
  } catch {
    return { ...extras };
  }
}

export function buildStructureFeatures(candles: Candle[]): StructureFeatures {
  const current = lastCandle(candles);
  const len = candles.length;

  const lookbackStart = Math.max(0, len - STRUCTURE_LOOKBACK - 1);
  const lookbackEnd = len - 1;
  const lookbackCandles = candles.slice(lookbackStart, lookbackEnd);

  const atr = candles.length >= 20 ? latestAtr(candles, 14) : current.close * 0.02;
  const atrPct = atr > 0 ? (atr / current.close) * 100 : 2;
  const tolerancePct = fibTolerancePct(atrPct);

  // Phase 5 — prefer confirmed impulse anchors
  const impulse = candles.length >= 40
    ? selectConfirmedBullishImpulse(candles, { asOfIndex: len - 1 })
    : null;

  if (lookbackCandles.length === 0) {
    const recentHigh20 = round(current.high);
    const recentLow20 = round(current.low);
    return {
      recentResistance20: recentHigh20,
      recentSupport20: recentLow20,
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
        impulse?.swingHigh.price ?? recentHigh20,
        impulse?.swingLow.price ?? recentLow20,
        current.close,
        tolerancePct,
        impulse
          ? {
              fibSwingHigh: impulse.swingHigh.price,
              fibSwingLow: impulse.swingLow.price,
              fibSwingHighTs: impulse.swingHigh.ts,
              fibSwingLowTs: impulse.swingLow.ts,
              fibAnchorModelVersion: impulse.modelVersion,
            }
          : undefined,
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

  const prev = candles[len - 2];
  const isInsideDay = prev
    ? current.high <= prev.high && current.low >= prev.low
    : false;

  const avgRange = lookbackCandles.reduce((s, c) => s + (c.high - c.low), 0) / lookbackCandles.length;
  const currentRange = current.high - current.low;
  const rangeCompressionRatio = round(safeDivide(currentRange, avgRange), 2);

  let consecutiveHigherLows = 0;
  for (let i = candles.length - 2; i > 0; i--) {
    if (candles[i].low > candles[i - 1].low) consecutiveHigherLows++;
    else break;
  }

  let consecutiveLowerHighs = 0;
  for (let i = candles.length - 2; i > 0; i--) {
    if (candles[i].high < candles[i - 1].high) consecutiveLowerHighs++;
    else break;
  }

  const roundedRecentHigh20 = round(recentHigh20);
  const roundedRecentLow20 = round(recentLow20);
  const swingHigh = impulse?.valid ? impulse.swingHigh.price : roundedRecentHigh20;
  const swingLow = impulse?.valid ? impulse.swingLow.price : roundedRecentLow20;

  const fibExtras: Partial<StructureFeatures> = {};
  if (impulse?.valid) {
    fibExtras.fibSwingHigh = round(impulse.swingHigh.price);
    fibExtras.fibSwingLow = round(impulse.swingLow.price);
    fibExtras.fibSwingHighTs = impulse.swingHigh.ts;
    fibExtras.fibSwingLowTs = impulse.swingLow.ts;
    fibExtras.fibAnchorModelVersion = impulse.modelVersion;

    const zq = scoreFibonacciZoneQuality({
      close: current.close,
      atr,
      atrPct,
      swingHigh: impulse.swingHigh.price,
      swingLow: impulse.swingLow.price,
      candles,
      fromIndex: impulse.swingLow.index,
      toIndex: len - 1,
      trend: {
        ema20: current.close,
        ema50: current.close,
        close: current.close,
      },
      volume: { volumeVs20dAvg: 1 },
      structure: {
        recentSupport20: roundedRecentLow20,
        recentResistance20: roundedRecentHigh20,
      },
    });
    fibExtras.fibZoneQualityScore = zq.score;
  }

  return {
    recentResistance20: round(recentResistance20),
    recentSupport20: round(recentSupport20),
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
      swingHigh,
      swingLow,
      current.close,
      tolerancePct,
      fibExtras,
    ),
  };
}
