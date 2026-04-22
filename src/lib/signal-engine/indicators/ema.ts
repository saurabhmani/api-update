// ════════════════════════════════════════════════════════════════
//  EMA — Exponential Moving Average
// ════════════════════════════════════════════════════════════════

export function computeEma(values: number[], period: number): number[] {
  if (values.length < period || period <= 0) return [];
  // Validate no NaN/Infinity in the seed window
  for (let i = 0; i < period; i++) {
    if (!isFinite(values[i])) return [];
  }

  const k = 2 / (period + 1);
  const emaValues: number[] = new Array(values.length).fill(NaN);

  // Seed with SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) {
    sum += values[i];
  }
  emaValues[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    emaValues[i] = values[i] * k + emaValues[i - 1] * (1 - k);
  }

  return emaValues;
}

export function latestEma(values: number[], period: number): number {
  const ema = computeEma(values, period);
  return ema[ema.length - 1] ?? NaN;
}
