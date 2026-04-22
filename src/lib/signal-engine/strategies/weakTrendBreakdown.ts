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

  // ── Structural weakness: price below EMA50 ────────────────
  // Closing below the 50-EMA is the medium-term trend boundary.
  // If close is above EMA50, the stock is technically in an uptrend
  // — wrong pool for this strategy.
  if (trend.closeAbove50Ema) {
    return reject('Price still above 50-EMA — not in downtrend');
  }

  // ── Bearish EMA stack ─────────────────────────────────────
  // ema20 below ema50 confirms the short-term MA is pulling the
  // longer MA down. A bullish or flat stack would mean the trend
  // is at best stalling, not weakening.
  if (trend.ema20 >= trend.ema50) {
    return reject('EMA stack is not bearish (EMA20 ≥ EMA50)');
  }

  // ── Price in lower half of 20-day range ───────────────────
  // Proxy for "lower highs + lower lows". If price is in the top
  // half of its 20-day range, it's likely bouncing off recent
  // support — wrong setup for a downtrend continuation short.
  const hi20   = structure.recentResistance20;
  const lo20   = structure.recentSupport20;
  const range  = hi20 - lo20;
  if (range <= 0) return reject('20-day range is degenerate');
  const positionInRange = (trend.close - lo20) / range;   // 0 = at low, 1 = at high
  if (positionInRange > 0.5) {
    return reject(`Price in upper half of 20-day range: ${(positionInRange * 100).toFixed(0)}%`);
  }

  // ── Room for the trade to develop ─────────────────────────
  // If price is within 3% of recent support, there's no room to
  // fall before hitting the first technical floor — risk/reward
  // is poor. Require at least 5% of headroom downward.
  const distToSupport = structure.distanceToSupportPct;
  if (distToSupport < 5) {
    return reject(`Too close to 20-day support: ${distToSupport.toFixed(2)}% — limited downside runway`);
  }

  // ── Momentum confirms downside (soft gate) ────────────────
  // Unlike bearish_breakdown which requires RSI < 55, we accept
  // up to 58 here — the trend is the primary signal, not a fresh
  // momentum crack. But we reject MACD positive, which would
  // indicate momentum is diverging from trend (possible reversal).
  if (momentum.rsi14 > 58) {
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
