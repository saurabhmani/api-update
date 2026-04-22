// ════════════════════════════════════════════════════════════════
//  Bullish Divergence Strategy
//
//  Detects stocks where price makes a lower low but RSI makes
//  a higher low — a classic momentum failure signaling reversal.
//  Statistically high-probability setup when confirmed.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

export function evaluateBullishDivergence(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, volatility, structure, context } = features;

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  // ── Block in extreme volatility ──────────────────────────
  if (context.marketRegime === 'High Volatility Risk') {
    return reject('Divergence blocked in high volatility regime');
  }

  // ── Must have actual divergence ──────────────────────────
  if (!momentum.bullishDivergence) {
    return reject('No bullish divergence detected');
  }

  // ── RSI should be in recovery zone, not deep crash ───────
  // RSI 25-50: oversold territory where divergence is meaningful
  if (momentum.rsi14 > 50) {
    return reject(`RSI too high for divergence trade: ${momentum.rsi14}`);
  }
  if (momentum.rsi14 < 15) {
    return reject(`RSI in capitulation territory — wait for stabilization: ${momentum.rsi14}`);
  }

  // ── Near support structure ───────────────────────────────
  const distFromLow = ((trend.close - structure.recentLow20) / structure.recentLow20) * 100;
  if (distFromLow > 8) {
    return reject(`Price ${distFromLow.toFixed(1)}% above recent low — not near support`);
  }

  // ── Some volume confirmation ─────────────────────────────
  if (volume.volumeVs20dAvg < 0.7) {
    return reject('Volume too thin for reversal confirmation');
  }

  // ── Long-term structure not destroyed ────────────────────
  if (trend.distanceFrom50EmaPct < -15) {
    return reject('Structural damage too severe — too far below 50 EMA');
  }

  // ── Rejection filters ────────────────────────────────────
  if (volatility.atrPct > 5.5) return reject(`ATR% too extreme: ${volatility.atrPct}`);
  if (Math.abs(volatility.gapPct) > 4.0) return reject(`Gap too large: ${volatility.gapPct}%`);

  // ── Stochastic confirmation (should be oversold or crossing up) ──
  if (momentum.stochasticK > 70) {
    return reject('Stochastic not confirming oversold — already elevated');
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
