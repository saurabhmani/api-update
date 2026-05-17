// ════════════════════════════════════════════════════════════════
//  Volatility Squeeze Breakout (Phase 4A)
//
//  Detects a Bollinger-Band squeeze resolving into an expansion
//  with participation. Conditions:
//    - `volatility.squeezed` is true (band-width compressed)
//    - latest candle breaks ABOVE the upper band with volume
//    - momentum agrees (RSI > 50, MACD histogram > 0)
//    - regime is supportive (Bullish / Strong Bullish / Sideways)
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

export function evaluateVolatilitySqueezeBreakout(f: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, structure, volatility, context } = f;

  // 1. Squeeze flag must be on.
  if (!volatility.squeezed) {
    return { matched: false, rejectionReason: 'No volatility compression detected on this bar.' };
  }

  // 2. Breakout above the upper band, with the close anchoring the
  //    move (we want a real expansion, not a wick).
  if (trend.close <= volatility.bollingerUpper) {
    return { matched: false, rejectionReason: 'Close has not broken above the upper Bollinger band.' };
  }

  // 3. Volume expansion confirms participation.
  if (volume.volumeVs20dAvg < 1.4) {
    return { matched: false, rejectionReason: 'Breakout lacks volume expansion (need ≥ 1.4× average).' };
  }

  // 4. Momentum agrees with the direction.
  if (momentum.rsi14 < 50 || momentum.macdHistogram <= 0) {
    return { matched: false, rejectionReason: 'Momentum does not confirm the expansion.' };
  }

  // 5. Regime is supportive — the squeeze resolving lower in a
  //    bearish tape is a different setup (and not what this strategy
  //    is registered for).
  if (context.marketRegime === 'Bearish' || context.marketRegime === 'High Volatility Risk') {
    return { matched: false, rejectionReason: 'Regime is not supportive of a bullish squeeze resolution.' };
  }

  // 6. Structure sanity — we should be near a recent high, not
  //    breaking out from a chaotic range.
  if (trend.close < structure.recentHigh20 * 0.99) {
    return { matched: false, rejectionReason: 'Close is not near the recent high — structure too chaotic.' };
  }

  return { matched: true };
}
