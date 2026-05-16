// ════════════════════════════════════════════════════════════════
//  Bullish Pullback Strategy — Phase 2
//
//  Detects stocks in confirmed uptrends that have pulled back
//  to key moving average support with cooling momentum.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';
import { BULLISH_ALLOWED_REGIMES } from '../constants/signalEngine.constants';

export function evaluateBullishPullback(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, volatility, context } = features;

  // ── Regime ────────────────────────────────────────────────
  if (!(BULLISH_ALLOWED_REGIMES as readonly string[]).includes(context.marketRegime)) {
    return reject(`Regime not allowed: ${context.marketRegime}`);
  }

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  // ── Uptrend confirmed ─────────────────────────────────────
  if (!trend.ema20Above50) return reject('No uptrend: EMA20 not above EMA50');
  if (!trend.closeAbove200Ema) return reject('Price below 200 EMA — no long-term uptrend');

  // ── Pullback to support (close near or touching EMA20/50) ─
  // Price should be within 1.5% above EMA20 or between EMA20 and EMA50
  const nearEma20 = trend.distanceFrom20EmaPct <= 1.5 && trend.distanceFrom20EmaPct >= -1.0;
  const betweenEmas = trend.closeAbove50Ema && !trend.closeAbove20Ema;
  if (!nearEma20 && !betweenEmas) {
    return reject(`Not in pullback zone: ${trend.distanceFrom20EmaPct.toFixed(1)}% from EMA20`);
  }

  // ── Momentum cooled but not dead ──────────────────────────
  if (momentum.rsi14 < 40) return reject(`RSI too weak: ${momentum.rsi14}`);
  if (momentum.rsi14 > 65) return reject(`RSI too hot for pullback: ${momentum.rsi14}`);

  // ── Volume contraction (pullbacks should have lower volume) ─
  if (volume.volumeVs20dAvg > 1.8) {
    return reject('Volume too high for pullback — suggests distribution');
  }

  // ── Rejection filters ─────────────────────────────────────
  if (volatility.atrPct > 5.0) return reject(`ATR% too high: ${volatility.atrPct}`);
  if (Math.abs(volatility.gapPct) > 3.0) return reject(`Gap too large: ${volatility.gapPct}%`);
  if (momentum.macdHistogram < -0.5 && momentum.roc5 < -3) {
    return reject('Momentum deteriorating too fast for pullback entry');
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
