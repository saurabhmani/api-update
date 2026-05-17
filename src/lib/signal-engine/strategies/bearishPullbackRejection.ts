// ════════════════════════════════════════════════════════════════
//  Bearish Pullback Rejection (Phase 4A)
//
//  Detects a weak rally into resistance inside a downtrend — the
//  classic continuation-short setup. The broader trend has to be
//  weak (close below EMA50, or EMA20 below EMA50), price has to
//  have rallied into the EMA20/resistance band, and the latest
//  candle must show rejection with volume confirming sellers.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

export function evaluateBearishPullbackRejection(f: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, structure, volatility } = f;

  // 1. Broader trend must be weak.
  const downtrend = !trend.closeAbove50Ema || !trend.ema20Above50;
  if (!downtrend) {
    return { matched: false, rejectionReason: 'Broader trend is not weak enough for a continuation-short.' };
  }

  // 2. Price must have RALLIED into resistance / EMA20 in this bar.
  //    Use the recent high vs EMA20 as the rally check, and the
  //    distance-from-EMA20 percentage as the proximity check.
  const ralliedIntoEma20 = structure.recentHigh20 >= trend.ema20 * 0.997
                        && Math.abs(trend.distanceFrom20EmaPct) < 2;
  const nearResistance   = structure.distanceToResistancePct < 1.5;
  if (!ralliedIntoEma20 && !nearResistance) {
    return { matched: false, rejectionReason: 'Price has not rallied into resistance or the EMA20 band.' };
  }

  // 3. Rejection candle — close in the lower half of the bar range
  //    AND today's high made an attempt above EMA20 / resistance.
  const rangeHigh = Math.max(trend.close, trend.open, structure.recentHigh20);
  const rangeLow  = Math.min(trend.close, trend.open, structure.recentLow20);
  const range     = rangeHigh - rangeLow;
  if (range <= 0) {
    return { matched: false, rejectionReason: 'Range is too compressed to measure rejection.' };
  }
  const closeInLowerHalf = (trend.close - rangeLow) / range < 0.45;
  if (!closeInLowerHalf) {
    return { matched: false, rejectionReason: 'No close-in-lower-half rejection candle.' };
  }

  // 4. Volume / momentum confirmation.
  const sellerVolume    = volume.volumeVs20dAvg >= 1.0;
  const weakMomentum    = momentum.rsi14 < 55 && momentum.macdHistogram <= 0;
  if (!sellerVolume && !weakMomentum) {
    return { matched: false, rejectionReason: 'No volume / momentum confirmation behind the rejection.' };
  }

  // 5. Wick must be meaningful relative to ATR.
  const upperWick = rangeHigh - trend.close;
  if (upperWick < volatility.atr14 * 0.4) {
    return { matched: false, rejectionReason: 'Rejection wick is too small relative to ATR.' };
  }

  return { matched: true };
}
