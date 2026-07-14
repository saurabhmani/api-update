// ════════════════════════════════════════════════════════════════
//  Fibonacci Zone Quality — Product A Phase 5
// ════════════════════════════════════════════════════════════════

import type { Candle, StructureFeatures, TrendFeatures, VolumeFeatures } from '../types/signalEngine.types';
import {
  calculateFibonacciLevels,
  isPriceNearFibLevel,
  type FibLevelName,
  type FibonacciLevels,
} from '../indicators/fibonacci';
import { round, safeDivide } from '../utils/math';

export const FIB_ZONE_QUALITY_VERSION = '2.0.0';

/** Volatility-aware tolerance (%), capped. */
export function fibTolerancePct(atrPct: number): number {
  // Base 0.6% + 0.25 * ATR%, capped at 1.25% — never globally widen
  const raw = 0.6 + Math.max(0, atrPct) * 0.25;
  return round(Math.min(1.25, Math.max(0.45, raw)), 2);
}

export interface FibZoneQualityInput {
  close: number;
  atr: number;
  atrPct: number;
  swingHigh: number;
  swingLow: number;
  candles: Candle[];
  fromIndex: number;
  toIndex: number;
  trend: Pick<TrendFeatures, 'ema20' | 'ema50' | 'close'>;
  volume: Pick<VolumeFeatures, 'volumeVs20dAvg'>;
  structure: Pick<StructureFeatures, 'recentSupport20' | 'recentResistance20'>;
  /** Optional anchored VWAP. */
  anchoredVwap?: number | null;
  /** Optional MTF fib overlap bonus 0–1. */
  mtfFibOverlap?: number | null;
}

export interface FibZoneQualityResult {
  score: number; // 0–100
  activeLevel: FibLevelName | null;
  activeLevelPrice: number | null;
  distanceAtr: number | null;
  tolerancePct: number;
  touches: number;
  rejectionStrength: number;
  confluences: string[];
  volumeContractionPullback: boolean;
  volumeExpansionReaction: boolean;
  levels: FibonacciLevels;
  zoneMatched: boolean;
}

const KEY_LEVELS: FibLevelName[] = ['fib382', 'fib50', 'fib618', 'fib786'];

export function scoreFibonacciZoneQuality(input: FibZoneQualityInput): FibZoneQualityResult {
  const levels = calculateFibonacciLevels(input.swingHigh, input.swingLow);
  const tolerancePct = fibTolerancePct(input.atrPct);
  const confluences: string[] = [];

  let activeLevel: FibLevelName | null = null;
  let activeLevelPrice: number | null = null;
  let bestDist = Infinity;

  for (const name of KEY_LEVELS) {
    const v = levels[name];
    if (v == null) continue;
    const dist = Math.abs(input.close - v);
    if (dist < bestDist && isPriceNearFibLevel(input.close, v, tolerancePct)) {
      bestDist = dist;
      activeLevel = name;
      activeLevelPrice = v;
    }
  }

  // Prefer nearest key level even slightly outside for scoring, but zoneMatched requires tolerance
  if (!activeLevel) {
    for (const name of KEY_LEVELS) {
      const v = levels[name];
      if (v == null) continue;
      const dist = Math.abs(input.close - v);
      if (dist < bestDist) {
        bestDist = dist;
        activeLevel = name;
        activeLevelPrice = v;
      }
    }
  }

  const zoneMatched =
    activeLevelPrice != null &&
    isPriceNearFibLevel(input.close, activeLevelPrice, tolerancePct);

  const distanceAtr =
    activeLevelPrice != null && input.atr > 0
      ? round(Math.abs(input.close - activeLevelPrice) / input.atr, 3)
      : null;

  // Level preference weights
  let score = 0;
  if (activeLevel === 'fib618') score += 22;
  else if (activeLevel === 'fib50') score += 20;
  else if (activeLevel === 'fib382') score += 16;
  else if (activeLevel === 'fib786') score += 14;

  if (distanceAtr != null) {
    score += Math.max(0, 15 - distanceAtr * 10);
  }

  const touches = countTouches(
    input.candles,
    input.fromIndex,
    input.toIndex,
    activeLevelPrice,
    tolerancePct,
  );
  score += Math.min(12, touches * 4);

  const rejectionStrength = measureRejectionStrength(
    input.candles,
    input.toIndex,
    activeLevelPrice,
  );
  score += Math.min(12, rejectionStrength * 12);

  // EMA confluence
  if (activeLevelPrice != null) {
    const nearEma20 = Math.abs(activeLevelPrice - input.trend.ema20) / input.trend.ema20 <= 0.012;
    const nearEma50 = Math.abs(activeLevelPrice - input.trend.ema50) / input.trend.ema50 <= 0.015;
    if (nearEma20) {
      score += 8;
      confluences.push('EMA20');
    }
    if (nearEma50) {
      score += 8;
      confluences.push('EMA50');
    }
    const nearSupport =
      Math.abs(activeLevelPrice - input.structure.recentSupport20) /
        Math.max(input.structure.recentSupport20, 1e-9) <=
      0.015;
    if (nearSupport) {
      score += 6;
      confluences.push('prior_support');
    }
  }

  if (input.anchoredVwap != null && activeLevelPrice != null) {
    if (Math.abs(activeLevelPrice - input.anchoredVwap) / input.anchoredVwap <= 0.01) {
      score += 6;
      confluences.push('anchored_VWAP');
    }
  }

  if (input.mtfFibOverlap != null && input.mtfFibOverlap > 0) {
    score += Math.min(10, input.mtfFibOverlap * 10);
    confluences.push('MTF_fib_overlap');
  }

  const { contraction, expansion } = volumePullbackProfile(
    input.candles,
    input.fromIndex,
    input.toIndex,
  );
  if (contraction) {
    score += 5;
  }
  if (expansion) {
    score += 6;
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    activeLevel,
    activeLevelPrice: activeLevelPrice != null ? round(activeLevelPrice) : null,
    distanceAtr,
    tolerancePct,
    touches,
    rejectionStrength: round(rejectionStrength, 3),
    confluences,
    volumeContractionPullback: contraction,
    volumeExpansionReaction: expansion,
    levels,
    zoneMatched,
  };
}

function countTouches(
  candles: Candle[],
  from: number,
  to: number,
  level: number | null,
  tolerancePct: number,
): number {
  if (level == null) return 0;
  let n = 0;
  for (let i = Math.max(0, from); i <= to; i++) {
    const c = candles[i];
    if (c.low <= level * (1 + tolerancePct / 100) && c.high >= level * (1 - tolerancePct / 100)) {
      n++;
    }
  }
  return n;
}

function measureRejectionStrength(
  candles: Candle[],
  idx: number,
  level: number | null,
): number {
  if (level == null || idx < 0 || idx >= candles.length) return 0;
  const c = candles[idx];
  const range = c.high - c.low;
  if (range <= 0) return 0;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const closeLoc = (c.close - c.low) / range;
  const nearLevel = c.low <= level * 1.01 && c.close >= level * 0.995;
  if (!nearLevel) return Math.min(1, lowerWick / range);
  return Math.min(1, 0.4 * (lowerWick / range) + 0.6 * closeLoc);
}

function volumePullbackProfile(
  candles: Candle[],
  from: number,
  to: number,
): { contraction: boolean; expansion: boolean } {
  if (to - from < 6) return { contraction: false, expansion: false };
  const mid = from + Math.floor((to - from) * 0.6);
  const early = candles.slice(from, mid);
  const late = candles.slice(mid, to + 1);
  const avg = (arr: Candle[]) =>
    arr.reduce((s, c) => s + (c.volume || 0), 0) / Math.max(1, arr.length);
  const a = avg(early);
  const b = avg(late);
  return {
    contraction: a > 0 && b < a * 0.9,
    expansion: a > 0 && (candles[to].volume || 0) > a * 1.05,
  };
}

export function distanceToLevelAtr(price: number, level: number, atr: number): number {
  return atr > 0 ? Math.abs(price - level) / atr : Infinity;
}

void safeDivide;
