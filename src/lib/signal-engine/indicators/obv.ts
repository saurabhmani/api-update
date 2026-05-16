// ════════════════════════════════════════════════════════════════
//  OBV — On-Balance Volume
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../types/signalEngine.types';

export function computeObv(candles: Candle[]): number[] {
  if (candles.length === 0) return [];

  const obv: number[] = new Array(candles.length).fill(0);
  obv[0] = candles[0].volume;

  for (let i = 1; i < candles.length; i++) {
    if (candles[i].close > candles[i - 1].close) {
      obv[i] = obv[i - 1] + candles[i].volume;
    } else if (candles[i].close < candles[i - 1].close) {
      obv[i] = obv[i - 1] - candles[i].volume;
    } else {
      obv[i] = obv[i - 1]; // unchanged
    }
  }

  return obv;
}

export function latestObv(candles: Candle[]): number {
  const obv = computeObv(candles);
  return obv[obv.length - 1] ?? 0;
}

export function obvSlope(candles: Candle[], period = 10): number {
  const obv = computeObv(candles);
  const len = obv.length;
  if (len < period + 1) return 0;

  const current = obv[len - 1];
  const past = obv[len - 1 - period];

  // Normalized slope: OBV change as percentage of average volume
  const avgVol = candles.slice(-period).reduce((s, c) => s + c.volume, 0) / period;
  if (avgVol === 0) return 0;
  return ((current - past) / avgVol) * 100;
}
