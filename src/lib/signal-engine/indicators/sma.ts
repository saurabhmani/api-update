// ════════════════════════════════════════════════════════════════
//  SMA — Simple Moving Average
// ════════════════════════════════════════════════════════════════

export function computeSma(values: number[], period: number): number[] {
  if (values.length < period || period <= 0) return [];

  const smaValues: number[] = new Array(values.length).fill(NaN);

  let sum = 0;
  for (let i = 0; i < period; i++) {
    if (!isFinite(values[i])) return [];
    sum += values[i];
  }
  smaValues[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    if (!isFinite(values[i])) {
      smaValues[i] = smaValues[i - 1]; // carry forward on bad data
      continue;
    }
    sum += values[i] - values[i - period];
    smaValues[i] = sum / period;
  }

  return smaValues;
}

export function latestSma(values: number[], period: number): number {
  const sma = computeSma(values, period);
  return sma[sma.length - 1] ?? NaN;
}

export function computeStdDev(values: number[], period: number): number[] {
  if (values.length < period || period <= 0) return [];

  const result: number[] = new Array(values.length).fill(NaN);

  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = window.reduce((s, v) => s + v, 0) / period;
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    result[i] = Math.sqrt(variance);
  }

  return result;
}

export function latestStdDev(values: number[], period: number): number {
  const std = computeStdDev(values, period);
  return std[std.length - 1] ?? NaN;
}
