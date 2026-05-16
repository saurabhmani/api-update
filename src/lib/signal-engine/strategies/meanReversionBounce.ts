// ════════════════════════════════════════════════════════════════
//  Mean Reversion Bounce Strategy — Phase 2
//
//  Detects oversold stocks at structural support showing
//  early reversal signals with volume confirmation.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

export function evaluateMeanReversionBounce(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, volatility, structure, context } = features;

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  // ── Block in extreme bearish (capitulation risk) ──────────
  if (context.marketRegime === 'High Volatility Risk') {
    return reject('Mean reversion blocked in high volatility regime');
  }

  // ── Oversold condition ────────────────────────────────────
  // Price must be below or near EMA20 AND RSI oversold
  if (trend.distanceFrom20EmaPct > 0.5) {
    return reject('Price not below EMA20 — no oversold condition');
  }

  if (momentum.rsi14 > 40) {
    return reject(`RSI not oversold: ${momentum.rsi14} (need < 40)`);
  }

  // ── Near support / structure ──────────────────────────────
  // Price should be near recent support (within 3% of 20-day low)
  const distFromLow = ((trend.close - structure.recentLow20) / structure.recentLow20) * 100;
  if (distFromLow > 5) {
    return reject(`Price ${distFromLow.toFixed(1)}% above recent low — not near support`);
  }

  // ── Bounce signal ─────────────────────────────────────────
  // Current candle should close above its open (bullish candle)
  // We approximate this through positive ROC-5 or positive daily change
  if (momentum.roc5 < -5) {
    return reject('No bounce yet — still accelerating down');
  }

  // ── Volume on bounce day ──────────────────────────────────
  if (volume.volumeVs20dAvg < 0.8) {
    return reject('Volume too thin on potential bounce');
  }

  // ── Rejection filters ─────────────────────────────────────
  if (volatility.atrPct > 5.5) return reject(`ATR% too extreme for reversal: ${volatility.atrPct}`);
  if (Math.abs(volatility.gapPct) > 4.0) return reject(`Gap too large: ${volatility.gapPct}%`);

  // Must have some long-term structure (not a total collapse)
  if (trend.distanceFrom50EmaPct < -12) {
    return reject('Price too far below EMA50 — structural damage too severe');
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
