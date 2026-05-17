// ════════════════════════════════════════════════════════════════
//  Failed Breakout Reversal (Phase 4A)
//
//  Detects bull-trap conditions on the daily timeframe. A breakout
//  above the recent 20-bar resistance fails when price closes back
//  inside the prior range with an upper-wick rejection and either
//  weakening momentum or a volume spike without follow-through.
//
//  Pure detector — works on EOD candle features alone. No fake
//  intraday data.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

export function evaluateFailedBreakoutReversal(f: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, structure, volatility } = f;
  const resistance = structure.recentResistance20;
  const close = trend.close;

  // 1. Recent breakout attempt — price traded above the 20-bar
  //    resistance at some point recently (we approximate with
  //    "today's high crossed resistance").
  const triedToBreakout = structure.recentHigh20 > resistance * 1.001;
  if (!triedToBreakout) {
    return { matched: false, rejectionReason: 'No recent breakout attempt above 20-bar resistance.' };
  }

  // 2. Failed to hold — close ends back BELOW the resistance.
  //    Use a small buffer so a marginal close above doesn't count.
  if (close >= resistance * 0.999) {
    return { matched: false, rejectionReason: 'Price still holding above the breakout level.' };
  }

  // 3. Upper wick rejection — distance from high to close is at
  //    least 0.5 × ATR so we know the failure came from a hostile
  //    intraday session, not a sleepy drift.
  const upperWick = structure.recentHigh20 - close;
  if (upperWick < volatility.atr14 * 0.5) {
    return { matched: false, rejectionReason: 'Upper-wick rejection too small to confirm trap.' };
  }

  // 4. Confirmation — at least one of:
  //    a) volume spike (more than 1.3× average) without price follow-through
  //    b) weakening momentum (RSI below 60 with bearish slope)
  const volumeSpike    = volume.volumeVs20dAvg >= 1.3;
  const momentumWeak   = momentum.rsi14 < 60 && momentum.macdHistogram <= 0;
  if (!volumeSpike && !momentumWeak) {
    return { matched: false, rejectionReason: 'No volume spike or momentum weakness to confirm trap.' };
  }

  return { matched: true };
}
