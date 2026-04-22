// ════════════════════════════════════════════════════════════════
//  Overbought Reversal Strategy — SELL (Phase 2)
//
//  Mirror of `oversold_bounce` for the bearish side. Identifies
//  stocks that have rallied into overbought territory near known
//  resistance, betting that mean reversion will drag price back
//  toward EMA20 or recent support.
//
//  Use cases:
//    - Strong names that have sprinted 5-10% above EMA20 in a
//      short window and are stalling at resistance.
//    - Momentum chasers hitting a technical ceiling.
//    - Event-driven spikes that exhaust before the close.
//
//  NOT to be used as the PRIMARY strategy in a strong bull market —
//  mean reversion against trend burns. The regime guard below keeps
//  it out of Strong Bullish tapes.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

export function evaluateOverboughtReversal(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volatility, structure, context } = features;

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  // ── Regime: not allowed in Strong Bullish ─────────────────
  // Fighting a roaring trend with mean-reversion is how you bleed.
  if (context.marketRegime === 'Strong Bullish') {
    return reject('Overbought reversal blocked in Strong Bullish regime');
  }

  // ── Overbought momentum (core trigger) ────────────────────
  // RSI > 70 is the classic overbought threshold. We accept 68+ to
  // catch setups that are knocking on the door and likely to roll
  // over; a strict >70 gate misses the early entry.
  if (momentum.rsi14 < 68) {
    return reject(`RSI not overbought enough: ${momentum.rsi14}`);
  }

  // ── Price near resistance ─────────────────────────────────
  // distanceToResistancePct measures how far below the 20-day
  // resistance the close sits. Positive = below resistance,
  // negative = above. We want the price AT resistance or just
  // above — within 2% either side.
  const distToRes = structure.distanceToResistancePct;
  if (Math.abs(distToRes) > 2) {
    return reject(`Price not near 20-day resistance: ${distToRes.toFixed(2)}% away`);
  }

  // ── Price extended above EMA20 ────────────────────────────
  // Mean-reversion edge scales with how stretched price is from
  // the short MA. Require price to be at least 3% above EMA20 —
  // anything closer is a minor wiggle, not a rubber band.
  const ema20 = trend.ema20;
  if (ema20 <= 0) return reject('EMA20 not available');
  const extensionPct = ((trend.close - ema20) / ema20) * 100;
  if (extensionPct < 3) {
    return reject(`Price not extended above EMA20: ${extensionPct.toFixed(2)}%`);
  }

  // ── Volatility safety ─────────────────────────────────────
  // Extreme vol = the prior rally may be a news spike that has
  // no technical gravity. Mean-reversion in that regime is a coin
  // flip. Keep the gate slightly tighter than breakdown (5 vs 6).
  if (volatility.atrPct > 5.0) {
    return reject(`ATR% extreme: ${volatility.atrPct}`);
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
