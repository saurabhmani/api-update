// ════════════════════════════════════════════════════════════════
//  Gap & Continuation Strategy
//
//  Detects gap-ups in the direction of the trend with volume
//  that hold above the gap level — "gap and go" setups.
//  Highest confidence when gap occurs in uptrend with volume.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';
import { BULLISH_ALLOWED_REGIMES } from '../constants/signalEngine.constants';

export function evaluateGapContinuation(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, volatility, structure, context } = features;

  // ── Regime: needs at least bullish context ────────────────
  if (!(BULLISH_ALLOWED_REGIMES as readonly string[]).includes(context.marketRegime)) {
    return reject(`Regime not suitable for gap trade: ${context.marketRegime}`);
  }

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  // ── Must have a significant gap up ───────────────────────
  // Gap of 1.5-5%: meaningful but not extreme
  if (volatility.gapPct < 1.5) {
    return reject(`Gap too small: ${volatility.gapPct}% (need ≥1.5%)`);
  }
  if (volatility.gapPct > 5.0) {
    return reject(`Gap too extreme — likely to fill: ${volatility.gapPct}%`);
  }

  // ── Trend alignment ──────────────────────────────────────
  if (!trend.closeAbove20Ema) return reject('Price below 20 EMA');
  if (!trend.ema20Above50) return reject('EMA20 not above EMA50');

  // ── Volume confirms the gap (institutional interest) ─────
  if (volume.volumeVs20dAvg < 1.5) {
    return reject(`Volume not confirming gap: ${volume.volumeVs20dAvg}x (need ≥1.5x)`);
  }

  // ── Momentum supportive ──────────────────────────────────
  if (momentum.rsi14 < 50 || momentum.rsi14 > 78) {
    return reject(`RSI not in gap-continuation range: ${momentum.rsi14}`);
  }
  if (momentum.macdHistogram <= 0) {
    return reject('MACD not supporting gap direction');
  }

  // ── Gap held: close should be near high, not filling ─────
  // Approximate: close > (open + gap_amount * 0.5)
  // We check close > EMA20 (already checked) and breakout distance is positive
  if (structure.breakoutDistancePct < 0) {
    return reject('Gap has filled — price back below resistance');
  }

  // ── Not too overextended ─────────────────────────────────
  if (trend.distanceFrom20EmaPct > 7) {
    return reject(`Too extended after gap: ${trend.distanceFrom20EmaPct}%`);
  }

  // ── Rejection filters ────────────────────────────────────
  if (volatility.atrPct > 5.5) return reject(`ATR% too high: ${volatility.atrPct}`);

  // ── No bearish divergence (momentum should confirm) ──────
  if (momentum.bearishDivergence) {
    return reject('Bearish divergence undermines gap setup');
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
