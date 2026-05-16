// ════════════════════════════════════════════════════════════════
//  MACD — Moving Average Convergence Divergence
// ════════════════════════════════════════════════════════════════

import { computeEma } from './ema';

export interface MacdResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

export function computeMacd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult {
  if (!closes.length || closes.some((v) => !isFinite(v))) {
    return { macdLine: [], signalLine: [], histogram: [] };
  }

  const emaFast = computeEma(closes, fastPeriod);
  const emaSlow = computeEma(closes, slowPeriod);

  const macdLine: number[] = new Array(closes.length).fill(NaN);

  // Find the first valid MACD index (where both EMAs are available)
  let firstValidIdx = -1;
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(emaFast[i]) && !isNaN(emaSlow[i])) {
      macdLine[i] = emaFast[i] - emaSlow[i];
      if (firstValidIdx === -1) firstValidIdx = i;
    }
  }

  // Compute signal line as EMA of MACD values, maintaining index alignment.
  // Signal line starts at (firstValidIdx + signalPeriod - 1) — standard behavior.
  const signalLine: number[] = new Array(closes.length).fill(NaN);
  const histogram: number[] = new Array(closes.length).fill(NaN);

  if (firstValidIdx >= 0) {
    // Seed signal line with SMA of first `signalPeriod` valid MACD values
    let validCount = 0;
    let sum = 0;
    const k = 2 / (signalPeriod + 1);

    for (let i = firstValidIdx; i < closes.length; i++) {
      if (isNaN(macdLine[i])) continue;

      validCount++;
      if (validCount <= signalPeriod) {
        sum += macdLine[i];
        if (validCount === signalPeriod) {
          signalLine[i] = sum / signalPeriod;
          histogram[i] = macdLine[i] - signalLine[i];
        }
      } else {
        // EMA smoothing: signal = macd * k + prevSignal * (1-k)
        const prevSignal = signalLine[i - 1] ?? signalLine[i]; // fallback for gaps
        let lastSignal = NaN;
        // Walk back to find the last valid signal
        for (let j = i - 1; j >= firstValidIdx; j--) {
          if (!isNaN(signalLine[j])) { lastSignal = signalLine[j]; break; }
        }
        if (!isNaN(lastSignal)) {
          signalLine[i] = macdLine[i] * k + lastSignal * (1 - k);
          histogram[i] = macdLine[i] - signalLine[i];
        }
      }
    }
  }

  return { macdLine, signalLine, histogram };
}

export function latestMacd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): { macdLine: number; macdSignal: number; macdHistogram: number } {
  const result = computeMacd(closes, fastPeriod, slowPeriod, signalPeriod);
  return {
    macdLine: result.macdLine[result.macdLine.length - 1] ?? NaN,
    macdSignal: result.signalLine[result.signalLine.length - 1] ?? NaN,
    macdHistogram: result.histogram[result.histogram.length - 1] ?? NaN,
  };
}
