// ════════════════════════════════════════════════════════════════
//  Bearish Breakdown Strategy — Phase 2
//
//  Detects stocks breaking below key support with confirming
//  volume expansion and deteriorating trend structure.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

const BEARISH_ALLOWED_REGIMES = ['Bearish', 'Weak', 'Sideways', 'High Volatility Risk'] as const;

export function evaluateBearishBreakdown(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, volatility, structure, context } = features;

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  // ── Regime: not allowed in strong bull ─────────────────────
  if (context.marketRegime === 'Strong Bullish') {
    return reject('Bearish breakdown blocked in Strong Bullish regime');
  }

  // ── Price broke below support ─────────────────────────────
  // Close below recent 20-day low (support breakdown)
  if (trend.close >= structure.recentSupport20) {
    return reject('Price has not broken below 20-day support');
  }

  // ── Trend deterioration ───────────────────────────────────
  if (trend.closeAbove20Ema && trend.closeAbove50Ema) {
    return reject('Price still above both EMAs — no breakdown structure');
  }

  // ── Momentum confirms weakness ────────────────────────────
  // Thresholds relaxed (Nov 2026 SELL-balance tune): rsi14 from
  // 55 → 60, so stocks with "healthy-looking" momentum that have
  // actually broken support still qualify. MACD hist must remain
  // ≤ 0 — that's the strategy's core bearish-momentum signal,
  // relaxing it would admit setups with no bearish conviction at
  // all. 60 also brings the RSI gate closer to parity with other
  // strategies' directional windows.
  if (momentum.rsi14 > 60) return reject(`RSI too strong for breakdown: ${momentum.rsi14}`);
  if (momentum.macdHistogram > 0) return reject('MACD histogram positive — no bearish momentum');

  // ── Volume expansion on breakdown ─────────────────────────
  // Relaxed from 1.2× → 1.0× (Nov 2026). Breakdowns in a bullish
  // broader tape often happen on normal volume (sector-specific
  // weakness rather than market-wide panic), which we were
  // systematically rejecting. 1.0× = at least average — still
  // rules out LOW-volume breaks which are typically fakeouts.
  if (volume.volumeVs20dAvg < 1.0) {
    return reject(`Volume too low for breakdown confirmation: ${volume.volumeVs20dAvg}x`);
  }

  // ── Rejection filters ─────────────────────────────────────
  if (volatility.atrPct > 6.0) return reject(`ATR% extreme: ${volatility.atrPct}`);

  // Avoid chasing after already-crashed stocks
  const breakdownDepth = Math.abs(structure.distanceToSupportPct);
  if (breakdownDepth > 8) {
    return reject(`Breakdown already too deep: ${breakdownDepth.toFixed(1)}% below support`);
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
