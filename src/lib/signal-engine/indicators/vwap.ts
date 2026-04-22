// ════════════════════════════════════════════════════════════════
//  VWAP — Volume-Weighted Average Price (rolling)
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../types/signalEngine.types';

export function computeVwap(candles: Candle[], period = 20): number[] {
  const len = candles.length;
  if (len === 0) return [];

  const vwap: number[] = new Array(len).fill(NaN);

  for (let i = Math.max(0, period - 1); i < len; i++) {
    const start = Math.max(0, i - period + 1);
    let sumPriceVol = 0;
    let sumVol = 0;

    for (let j = start; j <= i; j++) {
      const typicalPrice = (candles[j].high + candles[j].low + candles[j].close) / 3;
      sumPriceVol += typicalPrice * candles[j].volume;
      sumVol += candles[j].volume;
    }

    vwap[i] = sumVol > 0 ? sumPriceVol / sumVol : candles[i].close;
  }

  return vwap;
}

export function latestVwap(candles: Candle[], period = 20): number {
  const vwap = computeVwap(candles, period);
  return vwap[vwap.length - 1] ?? NaN;
}
