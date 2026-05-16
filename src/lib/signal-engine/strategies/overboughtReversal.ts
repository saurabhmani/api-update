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
  // SELL-balance tune: RSI gate 68 → 60 per operator spec. Classic
  // overbought is 70, 60 is "elevated" — we admit stretched names
  // earlier to keep the SELL pool populated. Combined with the
  // resistance/extension gates below, this still rules out random
  // mid-range stocks.
  if (momentum.rsi14 < 60) {
    return reject(`RSI not elevated enough: ${momentum.rsi14}`);
  }

  // ── Price near resistance ─────────────────────────────────
  // SELL-balance tune: proximity band 2% → 3%. Stocks that have
  // punched 2.5% through resistance still roll over; the previous
  // strict gate was filtering out mid-breakout exhaustion setups.
  const distToRes = structure.distanceToResistancePct;
  if (Math.abs(distToRes) > 3) {
    return reject(`Price not near 20-day resistance: ${distToRes.toFixed(2)}% away`);
  }

  // ── Price extended above EMA20 ────────────────────────────
  // SELL-balance tune: extension floor 3% → 2%. A 2% stretch above
  // EMA20 in an overbought name already has mean-reversion pressure;
  // waiting for 3%+ was too late for the early-entry edge.
  const ema20 = trend.ema20;
  if (ema20 <= 0) return reject('EMA20 not available');
  const extensionPct = ((trend.close - ema20) / ema20) * 100;
  if (extensionPct < 2) {
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
