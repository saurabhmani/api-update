// ════════════════════════════════════════════════════════════════
//  Oversold Bounce Strategy
//
//  Catches bounces from deeply oversold conditions near key support.
//  Different from mean_reversion_bounce: this requires RSI < 30
//  (more extreme) + support proximity + reversal candle pattern.
//
//  Entry: RSI < 30, price near support, with a green reversal bar
//  Works in: Sideways, Weak, Bearish regimes (counter-trend)
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

export function evaluateOversoldBounce(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, structure, context } = features;

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  const allowedRegimes = ['Sideways', 'Weak', 'Bearish', 'Bullish'];
  if (!allowedRegimes.includes(context.marketRegime)) {
    return reject(`Regime not allowed: ${context.marketRegime}`);
  }

  // RSI must be deeply oversold (< 30)
  if (momentum.rsi14 >= 30) {
    return reject(`RSI not oversold enough: ${momentum.rsi14.toFixed(0)} (need < 30)`);
  }

  // Price must be near support (within 3% of 20-day low)
  const distFromSupport = structure.recentSupport20 > 0
    ? ((trend.close - structure.recentSupport20) / structure.recentSupport20) * 100
    : Infinity;
  if (distFromSupport > 3) {
    return reject(`Too far from support: ${distFromSupport.toFixed(1)}% (max 3%)`);
  }

  // Reversal candle: close > open (green bar)
  if (trend.close <= trend.open) {
    return reject('No reversal candle (close <= open)');
  }

  // Some buying pressure: volume should not be collapsing
  if (volume.volumeVs20dAvg < 0.6) {
    return reject(`Volume too low for bounce: ${volume.volumeVs20dAvg.toFixed(1)}x`);
  }

  // Price must be above SMA-200 (don't catch falling knives in structural downtrends)
  if (trend.sma200 > 0 && trend.close < trend.sma200 * 0.90) {
    return reject('Price too far below SMA-200 — structural downtrend');
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
