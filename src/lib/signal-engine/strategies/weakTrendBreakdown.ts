// ════════════════════════════════════════════════════════════════
//  Weak Trend Breakdown Strategy — SELL (Phase 2)
//
//  Catches stocks in a confirmed downtrend that haven't necessarily
//  just broken 20-day support (which is the bearish_breakdown
//  trigger) but show sustained structural weakness. This fills the
//  gap between "strong fresh breakdown" (bearish_breakdown) and
//  "moderate persistent weakness" (this one).
//
//  Use cases:
//    - Stocks trending lower for 10+ sessions without a bounce.
//    - Names under 50-EMA with a rising-MA gap (20 below 50).
//    - Failed retests of previous support that turned into new
//      resistance.
//
//  Structural "lower highs + lower lows" proxies the features
//  exposed by buildSignalFeatures don't have explicit trend-slope
//  fields, so we use a combination that's load-bearing equivalent:
//    1. close < EMA50           — below medium-term mean
//    2. EMA20 < EMA50            — bearish EMA stack
//    3. price in lower half of 20-day range
//    4. distance-to-resistance > 5% (room to fall before first
//       resistance check)
//
//  Intentionally does NOT require a fresh support break — that's
//  what bearish_breakdown is for. This strategy looks for stocks
//  that are "dead meat" in a downtrend, where the next move is
//  likely down even without a new low.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

export function evaluateWeakTrendBreakdown(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, volatility, structure, context } = features;

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  // ── Regime: not allowed in Strong Bullish ─────────────────
  // A broad rally lifts everything, even technically-weak names.
  // Shorting them in that tape is typically a trap.
  if (context.marketRegime === 'Strong Bullish') {
    return reject('Weak trend breakdown blocked in Strong Bullish regime');
  }

  // ── Structural weakness: price at or below EMA50 ──────────
  // SELL-balance tune: allow close up to 1% ABOVE EMA50 (sideways
  // regime). Previously required close strictly below — that
  // eliminated every "stalling near EMA50" setup, which is where
  // weak-trend continuation patterns usually start.
  const ema50Tol = trend.ema50 * 1.01;
  if (trend.close > ema50Tol) {
    return reject(`Price ${((trend.close / trend.ema50 - 1) * 100).toFixed(2)}% above 50-EMA — not in downtrend`);
  }

  // ── Bearish EMA stack (or flat) ───────────────────────────
  // SELL-balance tune: allow EMA20 within 0.5% above EMA50 — a
  // flat/rolling-over stack is still actionable for this strategy.
  // Hard-reject only when EMA20 is meaningfully above EMA50
  // (>0.5%) which would mean the short-term trend is bullish.
  if (trend.ema20 > trend.ema50 * 1.005) {
    return reject('EMA stack is bullish (EMA20 > EMA50 by >0.5%)');
  }

  // ── Price in lower 60% of 20-day range ────────────────────
  // SELL-balance tune: 0.5 → 0.6. A stock sitting at 55% of range
  // in a downtrending EMA stack is still a valid continuation
  // short; the previous 0.5 cap rejected those.
  const hi20   = structure.recentResistance20;
  const lo20   = structure.recentSupport20;
  const range  = hi20 - lo20;
  if (range <= 0) return reject('20-day range is degenerate');
  const positionInRange = (trend.close - lo20) / range;   // 0 = at low, 1 = at high
  if (positionInRange > 0.6) {
    return reject(`Price in upper range: ${(positionInRange * 100).toFixed(0)}%`);
  }

  // ── Room for the trade to develop ─────────────────────────
  // SELL-balance tune: 5% → 3% headroom. Even 3% to the next
  // support is usable downside for a continuation short on a
  // weak trend. Previously required 5% and was eliminating
  // most mid-trend setups.
  const distToSupport = structure.distanceToSupportPct;
  if (distToSupport < 3) {
    return reject(`Too close to 20-day support: ${distToSupport.toFixed(2)}% — limited downside runway`);
  }

  // ── Momentum confirms downside (soft gate) ────────────────
  // SELL-balance tune: RSI ceiling 58 → 62. The trend is the
  // primary signal here; a modestly-elevated RSI in a bearish
  // stack often precedes the next leg down.
  if (momentum.rsi14 > 62) {
    return reject(`RSI too high for weak-trend continuation: ${momentum.rsi14}`);
  }
  if (momentum.macdHistogram > 0) {
    return reject('MACD histogram positive — momentum diverging from trend');
  }

  // ── Liquidity safety ──────────────────────────────────────
  // A dying stock with near-zero volume is ungradeable. Require
  // at least some recent participation. 0.7× = below average but
  // not zombified — we don't need a volume spike, just a pulse.
  if (volume.volumeVs20dAvg < 0.7) {
    return reject(`Volume anaemic: ${volume.volumeVs20dAvg}x — uninvestable`);
  }

  // ── Volatility cap ────────────────────────────────────────
  if (volatility.atrPct > 6.0) {
    return reject(`ATR% extreme: ${volatility.atrPct}`);
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
