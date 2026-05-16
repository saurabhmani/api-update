// ════════════════════════════════════════════════════════════════
//  Divergence Detection — Price vs Momentum
// ════════════════════════════════════════════════════════════════

export interface DivergenceResult {
  bullishDivergence: boolean;
  bearishDivergence: boolean;
}

/**
 * Detects divergence between price and RSI over a lookback window.
 *
 * Bullish divergence: price makes lower low, but RSI makes higher low
 * Bearish divergence: price makes higher high, but RSI makes lower high
 *
 * Uses swing-point detection rather than raw values to reduce noise.
 */
export function detectDivergence(
  closes: number[],
  rsiValues: number[],
  lookback = 10,
): DivergenceResult {
  const len = closes.length;
  if (len < lookback + 2 || rsiValues.length < lookback + 2) {
    return { bullishDivergence: false, bearishDivergence: false };
  }

  // Find swing lows and swing highs in the lookback window
  const start = len - lookback;
  const end = len - 1;

  // Price swing points
  const priceLows: { idx: number; value: number }[] = [];
  const priceHighs: { idx: number; value: number }[] = [];

  for (let i = start + 1; i < end; i++) {
    if (closes[i] <= closes[i - 1] && closes[i] <= closes[i + 1]) {
      priceLows.push({ idx: i, value: closes[i] });
    }
    if (closes[i] >= closes[i - 1] && closes[i] >= closes[i + 1]) {
      priceHighs.push({ idx: i, value: closes[i] });
    }
  }

  let bullishDivergence = false;
  let bearishDivergence = false;

  // Bullish divergence: compare latest two swing lows
  if (priceLows.length >= 2) {
    const recent = priceLows[priceLows.length - 1];
    const prior = priceLows[priceLows.length - 2];

    // Price: lower low
    if (recent.value < prior.value) {
      // RSI: higher low (not making new low)
      const rsiRecent = rsiValues[recent.idx];
      const rsiPrior = rsiValues[prior.idx];
      if (isFinite(rsiRecent) && isFinite(rsiPrior) && rsiRecent > rsiPrior) {
        bullishDivergence = true;
      }
    }
  }

  // Bearish divergence: compare latest two swing highs
  if (priceHighs.length >= 2) {
    const recent = priceHighs[priceHighs.length - 1];
    const prior = priceHighs[priceHighs.length - 2];

    // Price: higher high
    if (recent.value > prior.value) {
      // RSI: lower high
      const rsiRecent = rsiValues[recent.idx];
      const rsiPrior = rsiValues[prior.idx];
      if (isFinite(rsiRecent) && isFinite(rsiPrior) && rsiRecent < rsiPrior) {
        bearishDivergence = true;
      }
    }
  }

  return { bullishDivergence, bearishDivergence };
}
