// ════════════════════════════════════════════════════════════════
//  RSI — Relative Strength Index (Wilder smoothing)
// ════════════════════════════════════════════════════════════════

export function computeRsi(closes: number[], period = 14): number[] {
  if (closes.length < period + 1 || period <= 0) return [];
  // Validate seed data
  for (let i = 0; i <= period; i++) {
    if (!isFinite(closes[i])) return [];
  }

  const rsiValues: number[] = new Array(closes.length).fill(NaN);

  let avgGain = 0;
  let avgLoss = 0;

  // Initial average gain/loss over first `period` changes
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;

  rsiValues[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  // Wilder smoothing for remaining values
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsiValues[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsiValues;
}

export function latestRsi(closes: number[], period = 14): number {
  const rsi = computeRsi(closes, period);
  return rsi[rsi.length - 1] ?? NaN;
}
