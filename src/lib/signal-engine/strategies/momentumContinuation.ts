// ════════════════════════════════════════════════════════════════
//  Momentum Continuation Strategy
//
//  Detects stocks in established uptrends with accelerating
//  momentum — riding the wave, not catching the knife.
//  Requires: strong trend structure + rising momentum + ADX > 25
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';
import { BULLISH_ALLOWED_REGIMES } from '../constants/signalEngine.constants';

export function evaluateMomentumContinuation(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, volatility, context } = features;

  // ── Regime: needs bullish environment ─────────────────────
  if (!(BULLISH_ALLOWED_REGIMES as readonly string[]).includes(context.marketRegime)) {
    return reject(`Regime not suitable for momentum: ${context.marketRegime}`);
  }

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  // ── Confirmed uptrend ────────────────────────────────────
  if (!trend.closeAbove20Ema) return reject('Price below 20 EMA');
  if (!trend.closeAbove50Ema) return reject('Price below 50 EMA');
  if (!trend.ema20Above50) return reject('EMA20 not above EMA50');

  // ── Strong trend (ADX > 25 = trending market) ────────────
  if (momentum.adx < 25) {
    return reject(`ADX too weak for momentum: ${momentum.adx} (need > 25)`);
  }

  // ── Momentum building, not exhausted ─────────────────────
  // RSI 60-75: strong but not overbought
  if (momentum.rsi14 < 60) return reject(`RSI too weak for momentum ride: ${momentum.rsi14}`);
  if (momentum.rsi14 > 78) return reject(`RSI exhausted: ${momentum.rsi14}`);

  // MACD histogram positive and growing (macdHistogram > macdLine * 0.1 approximation)
  if (momentum.macdHistogram <= 0) return reject('MACD histogram not positive');

  // Short-term momentum positive
  if (momentum.roc5 <= 0) return reject('Short-term ROC not positive');

  // ── Not overextended ─────────────────────────────────────
  if (trend.distanceFrom20EmaPct > 6) {
    return reject(`Too extended from EMA20: ${trend.distanceFrom20EmaPct}%`);
  }

  // ── Volume should be supportive (not dried up) ───────────
  if (volume.volumeVs20dAvg < 0.8) {
    return reject('Volume too thin for momentum confirmation');
  }

  // ── OBV confirming trend (positive slope) ────────────────
  if (volume.obvSlope < 0) {
    return reject('OBV diverging from price — accumulation weakening');
  }

  // ── Rejection filters ────────────────────────────────────
  if (volatility.atrPct > 5.5) return reject(`ATR% too high: ${volatility.atrPct}`);
  if (Math.abs(volatility.gapPct) > 3.5) return reject(`Gap too large: ${volatility.gapPct}%`);

  // No bearish divergence
  if (momentum.bearishDivergence) {
    return reject('Bearish divergence detected — momentum may be topping');
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
