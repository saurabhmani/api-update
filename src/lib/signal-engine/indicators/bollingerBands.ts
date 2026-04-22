// ════════════════════════════════════════════════════════════════
//  Bollinger Bands — SMA ± k × σ
// ════════════════════════════════════════════════════════════════

import { computeSma, computeStdDev } from './sma';

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  width: number[];
  pctB: number[];
}

export function computeBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2,
): BollingerResult {
  const len = closes.length;
  if (len < period) {
    return {
      upper: [], middle: [], lower: [], width: [], pctB: [],
    };
  }

  const sma = computeSma(closes, period);
  const stdDev = computeStdDev(closes, period);

  const upper: number[] = new Array(len).fill(NaN);
  const lower: number[] = new Array(len).fill(NaN);
  const width: number[] = new Array(len).fill(NaN);
  const pctB: number[] = new Array(len).fill(NaN);

  for (let i = period - 1; i < len; i++) {
    if (isNaN(sma[i]) || isNaN(stdDev[i])) continue;

    const band = stdDevMultiplier * stdDev[i];
    upper[i] = sma[i] + band;
    lower[i] = sma[i] - band;

    const bandWidth = upper[i] - lower[i];
    width[i] = sma[i] > 0 ? bandWidth / sma[i] : 0;

    // %B: where price sits within the bands (0 = lower, 1 = upper)
    pctB[i] = bandWidth > 0 ? (closes[i] - lower[i]) / bandWidth : 0.5;
  }

  return { upper, middle: sma, lower, width, pctB };
}

export function latestBollinger(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2,
): { upper: number; lower: number; width: number; pctB: number } {
  const result = computeBollingerBands(closes, period, stdDevMultiplier);
  const last = (arr: number[]) => arr[arr.length - 1] ?? NaN;
  return {
    upper: last(result.upper),
    lower: last(result.lower),
    width: last(result.width),
    pctB: last(result.pctB),
  };
}

export function isSqueezed(closes: number[], period = 20, stdDevMultiplier = 2): boolean {
  const bb = computeBollingerBands(closes, period, stdDevMultiplier);
  const len = bb.width.length;
  if (len < 20) return false;

  const currentWidth = bb.width[len - 1];
  if (isNaN(currentWidth)) return false;

  // Squeezed = current width is in bottom 20th percentile of last 100 bars
  const lookback = bb.width.slice(Math.max(0, len - 100)).filter((w) => !isNaN(w));
  if (lookback.length < 10) return false;

  const sorted = [...lookback].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.2)];
  return currentWidth <= threshold;
}
