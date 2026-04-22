// ════════════════════════════════════════════════════════════════
//  ATR — Average True Range (Wilder smoothing)
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../types/signalEngine.types';

export function trueRange(current: Candle, previous: Candle): number {
  const hl = current.high - current.low;
  const hc = Math.abs(current.high - previous.close);
  const lc = Math.abs(current.low - previous.close);
  return Math.max(hl, hc, lc);
}

export function computeAtr(candles: Candle[], period = 14): number[] {
  if (candles.length < period + 1 || period <= 0) return [];
  // Validate OHLC integrity of seed candles
  for (let i = 0; i <= period; i++) {
    const c = candles[i];
    if (!isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close) || c.high < c.low) {
      return [];
    }
  }

  const atrValues: number[] = new Array(candles.length).fill(NaN);

  // First ATR = simple average of first `period` true ranges
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += trueRange(candles[i], candles[i - 1]);
  }
  atrValues[period] = sum / period;

  // Wilder smoothing
  for (let i = period + 1; i < candles.length; i++) {
    const tr = trueRange(candles[i], candles[i - 1]);
    atrValues[i] = (atrValues[i - 1] * (period - 1) + tr) / period;
  }

  return atrValues;
}

export function latestAtr(candles: Candle[], period = 14): number {
  const atr = computeAtr(candles, period);
  return atr[atr.length - 1] ?? NaN;
}
