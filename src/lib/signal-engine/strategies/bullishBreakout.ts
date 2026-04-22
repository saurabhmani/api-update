// ════════════════════════════════════════════════════════════════
//  Bullish Breakout Strategy — Phase 1
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';
import {
  BREAKOUT_BUFFER,
  MIN_VOLUME_EXPANSION,
  RSI_LOWER_BOUND,
  RSI_UPPER_BOUND,
  MAX_BREAKOUT_EXTENSION_PCT,
  MAX_GAP_PCT,
  MAX_ATR_PCT,
  MAX_DISTANCE_FROM_EMA20_PCT,
  BULLISH_ALLOWED_REGIMES,
} from '../constants/signalEngine.constants';

export function evaluateBullishBreakout(
  features: SignalFeatures,
  breakoutBuffer = BREAKOUT_BUFFER,
): StrategyMatchResult {
  const { trend, momentum, volume, volatility, structure, context } = features;

  // ── Mandatory Conditions ───────────────────────────────────

  if (!context.liquidityPass) {
    return reject('Liquidity filter failed');
  }

  if (!(BULLISH_ALLOWED_REGIMES as readonly string[]).includes(context.marketRegime)) {
    return reject(`Market regime not allowed: ${context.marketRegime}`);
  }

  const breakoutThreshold = structure.recentResistance20 * breakoutBuffer;
  if (trend.close <= breakoutThreshold) {
    return reject('Price has not closed above resistance with buffer');
  }

  if (volume.volumeVs20dAvg < MIN_VOLUME_EXPANSION) {
    return reject(`Volume expansion insufficient: ${volume.volumeVs20dAvg}x < ${MIN_VOLUME_EXPANSION}x`);
  }

  if (!trend.closeAbove20Ema) {
    return reject('Price below 20 EMA');
  }

  if (!trend.closeAbove50Ema) {
    return reject('Price below 50 EMA');
  }

  if (!trend.ema20Above50) {
    return reject('EMA20 not above EMA50');
  }

  if (momentum.rsi14 < RSI_LOWER_BOUND || momentum.rsi14 > RSI_UPPER_BOUND) {
    return reject(`RSI out of ideal range: ${momentum.rsi14} (expected ${RSI_LOWER_BOUND}–${RSI_UPPER_BOUND})`);
  }

  if (momentum.macdHistogram <= 0) {
    return reject('MACD histogram not positive');
  }

  // ── Rejection Conditions ───────────────────────────────────

  if (structure.breakoutDistancePct > MAX_BREAKOUT_EXTENSION_PCT) {
    return reject(`Breakout too extended: ${structure.breakoutDistancePct}% > ${MAX_BREAKOUT_EXTENSION_PCT}%`);
  }

  if (Math.abs(volatility.gapPct) > MAX_GAP_PCT) {
    return reject(`Gap too large: ${volatility.gapPct}%`);
  }

  if (volatility.atrPct > MAX_ATR_PCT) {
    return reject(`ATR% too high: ${volatility.atrPct}%`);
  }

  if (trend.distanceFrom20EmaPct > MAX_DISTANCE_FROM_EMA20_PCT) {
    return reject(`Price too far from 20 EMA: ${trend.distanceFrom20EmaPct}%`);
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
