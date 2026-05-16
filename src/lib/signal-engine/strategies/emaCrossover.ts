// ════════════════════════════════════════════════════════════════
//  EMA Crossover Strategy
//
//  Detects bullish EMA crossovers (EMA-9 crossing above EMA-21).
//  Classic trend-following signal confirmed by volume.
//
//  Entry: EMA-9 > EMA-21 with price above both
//  Works in: Bullish, Strong Bullish, Sideways regimes
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

export function evaluateEmaCrossover(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, context } = features;

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  const allowedRegimes = ['Bullish', 'Strong Bullish', 'Sideways'];
  if (!allowedRegimes.includes(context.marketRegime)) {
    return reject(`Regime not allowed: ${context.marketRegime}`);
  }

  // EMA-9 must be above EMA-21 (bullish crossover)
  if (trend.ema9 <= trend.ema21) {
    return reject('EMA-9 not above EMA-21');
  }

  // Price must be above both EMAs
  if (trend.close < trend.ema9 || trend.close < trend.ema21) {
    return reject('Price below EMAs');
  }

  // The crossover should be recent — EMA gap should be small (<3%)
  const emaGapPct = trend.ema21 > 0
    ? ((trend.ema9 - trend.ema21) / trend.ema21) * 100
    : 0;
  if (emaGapPct > 3.0) {
    return reject(`EMA gap too wide (${emaGapPct.toFixed(1)}%) — crossover not recent`);
  }
  if (emaGapPct < 0.1) {
    return reject('EMAs too close — no clear crossover');
  }

  // ADX > 18 — trend must exist (but lower than breakout's 20 for more signals)
  if (momentum.adx < 18) {
    return reject(`ADX too low: ${momentum.adx.toFixed(0)}`);
  }

  // Volume should be at least average
  if (volume.volumeVs20dAvg < 0.8) {
    return reject(`Below average volume: ${volume.volumeVs20dAvg.toFixed(1)}x`);
  }

  // RSI confirmation — should be in bullish zone but not extreme
  if (momentum.rsi14 < 45 || momentum.rsi14 > 75) {
    return reject(`RSI out of range: ${momentum.rsi14.toFixed(0)} (need 45-75)`);
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
