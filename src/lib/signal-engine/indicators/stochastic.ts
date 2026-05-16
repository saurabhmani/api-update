// ════════════════════════════════════════════════════════════════
//  Stochastic Oscillator — %K and %D
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../types/signalEngine.types';
import { computeSma } from './sma';

export interface StochasticResult {
  k: number[];
  d: number[];
}

export function computeStochastic(
  candles: Candle[],
  kPeriod = 14,
  dPeriod = 3,
): StochasticResult {
  const len = candles.length;
  if (len < kPeriod) {
    return { k: [], d: [] };
  }

  const kValues: number[] = new Array(len).fill(NaN);

  for (let i = kPeriod - 1; i < len; i++) {
    let highestHigh = -Infinity;
    let lowestLow = Infinity;

    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > highestHigh) highestHigh = candles[j].high;
      if (candles[j].low < lowestLow) lowestLow = candles[j].low;
    }

    const range = highestHigh - lowestLow;
    kValues[i] = range > 0
      ? ((candles[i].close - lowestLow) / range) * 100
      : 50;
  }

  // %D = SMA of %K over dPeriod
  // Extract valid %K values for SMA computation
  const validK = kValues.filter((v) => !isNaN(v));
  const dSma = computeSma(validK, dPeriod);

  const dValues: number[] = new Array(len).fill(NaN);
  let validIdx = 0;
  for (let i = 0; i < len; i++) {
    if (!isNaN(kValues[i])) {
      if (validIdx < dSma.length && !isNaN(dSma[validIdx])) {
        dValues[i] = dSma[validIdx];
      }
      validIdx++;
    }
  }

  return { k: kValues, d: dValues };
}

export function latestStochastic(
  candles: Candle[],
  kPeriod = 14,
  dPeriod = 3,
): { k: number; d: number } {
  const result = computeStochastic(candles, kPeriod, dPeriod);
  return {
    k: result.k[result.k.length - 1] ?? NaN,
    d: result.d[result.d.length - 1] ?? NaN,
  };
}
