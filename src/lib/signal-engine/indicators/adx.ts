// ════════════════════════════════════════════════════════════════
//  ADX — Average Directional Index (trend strength)
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../types/signalEngine.types';
import { trueRange } from './atr';

export interface AdxResult {
  adx: number[];
  plusDi: number[];
  minusDi: number[];
}

export function computeAdx(candles: Candle[], period = 14): AdxResult {
  const len = candles.length;
  if (len < period * 2 + 1) {
    return { adx: [], plusDi: [], minusDi: [] };
  }

  const plusDm: number[] = new Array(len).fill(0);
  const minusDm: number[] = new Array(len).fill(0);
  const tr: number[] = new Array(len).fill(0);

  // Step 1: Compute +DM, -DM, TR
  for (let i = 1; i < len; i++) {
    const upMove = candles[i].high - candles[i - 1].high;
    const downMove = candles[i - 1].low - candles[i].low;

    plusDm[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDm[i] = downMove > upMove && downMove > 0 ? downMove : 0;
    tr[i] = trueRange(candles[i], candles[i - 1]);
  }

  // Step 2: Wilder smooth over period
  let smoothPlusDm = 0;
  let smoothMinusDm = 0;
  let smoothTr = 0;

  for (let i = 1; i <= period; i++) {
    smoothPlusDm += plusDm[i];
    smoothMinusDm += minusDm[i];
    smoothTr += tr[i];
  }

  const plusDi: number[] = new Array(len).fill(NaN);
  const minusDi: number[] = new Array(len).fill(NaN);
  const dx: number[] = new Array(len).fill(NaN);
  const adx: number[] = new Array(len).fill(NaN);

  // First DI values
  plusDi[period] = smoothTr > 0 ? (smoothPlusDm / smoothTr) * 100 : 0;
  minusDi[period] = smoothTr > 0 ? (smoothMinusDm / smoothTr) * 100 : 0;
  const diSum = plusDi[period] + minusDi[period];
  dx[period] = diSum > 0 ? Math.abs(plusDi[period] - minusDi[period]) / diSum * 100 : 0;

  // Continue Wilder smoothing
  for (let i = period + 1; i < len; i++) {
    smoothPlusDm = smoothPlusDm - smoothPlusDm / period + plusDm[i];
    smoothMinusDm = smoothMinusDm - smoothMinusDm / period + minusDm[i];
    smoothTr = smoothTr - smoothTr / period + tr[i];

    plusDi[i] = smoothTr > 0 ? (smoothPlusDm / smoothTr) * 100 : 0;
    minusDi[i] = smoothTr > 0 ? (smoothMinusDm / smoothTr) * 100 : 0;
    const sum = plusDi[i] + minusDi[i];
    dx[i] = sum > 0 ? Math.abs(plusDi[i] - minusDi[i]) / sum * 100 : 0;
  }

  // ADX = Wilder-smoothed DX starting at 2*period
  let adxSum = 0;
  for (let i = period; i < period * 2; i++) {
    adxSum += dx[i];
  }
  adx[period * 2 - 1] = adxSum / period;

  for (let i = period * 2; i < len; i++) {
    adx[i] = (adx[i - 1] * (period - 1) + dx[i]) / period;
  }

  return { adx, plusDi, minusDi };
}

export function latestAdx(candles: Candle[], period = 14): number {
  const result = computeAdx(candles, period);
  return result.adx[result.adx.length - 1] ?? NaN;
}
