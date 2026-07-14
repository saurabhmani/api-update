// ════════════════════════════════════════════════════════════════
//  Fibonacci Pullback Strategy
//
//  Detects bullish-trend pullbacks reacting from key Fibonacci
//  retracement zones (38.2%, 50%, 61.8%) with constructive momentum.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';
import { isPriceNearFibLevel } from '../indicators/fibonacci';

/** Matches structure feature golden-zone tolerance (default 1%). */
const FIB_ZONE_TOLERANCE_PCT = 1;
const MIN_VOLUME_RATIO = 0.8;

/**
 * Evaluates whether price is reacting from a Fibonacci retracement zone
 * inside a bullish trend with acceptable momentum and volume.
 */
export function evaluateFibonacciPullback(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, structure, context } = features;

  // ── Regime ────────────────────────────────────────────────
  if (!context.liquidityPass) return reject('Liquidity filter failed');

  // ── Fibonacci data ────────────────────────────────────────
  if (structure.fibZoneMatched !== true) {
    return reject('Price not in Fibonacci golden zone (38.2%/50%/61.8%)');
  }

  const { fib382, fib50, fib618, fib786 } = structure;
  if (fib382 === undefined && fib50 === undefined && fib618 === undefined) {
    return reject('Fibonacci levels unavailable');
  }

  const close = trend.close;
  const near382 = fib382 !== undefined && isPriceNearFibLevel(close, fib382, FIB_ZONE_TOLERANCE_PCT);
  const near50 = fib50 !== undefined && isPriceNearFibLevel(close, fib50, FIB_ZONE_TOLERANCE_PCT);
  const near618 = fib618 !== undefined && isPriceNearFibLevel(close, fib618, FIB_ZONE_TOLERANCE_PCT);
  if (!near382 && !near50 && !near618) {
    return reject('Price not near key Fibonacci retracement levels');
  }

  // ── Bullish trend ─────────────────────────────────────────
  if (!trend.ema20Above50) return reject('No uptrend: EMA20 not above EMA50');
  if (!trend.closeAbove200Ema) return reject('Price below 200 EMA — no long-term uptrend');

  // ── EMA support (above or near EMA20 / EMA50) ─────────────
  const nearEma20 = trend.distanceFrom20EmaPct <= 1.5 && trend.distanceFrom20EmaPct >= -1.0;
  const betweenEmas = trend.closeAbove50Ema && !trend.closeAbove20Ema;
  const aboveBothEmas = trend.closeAbove20Ema && trend.closeAbove50Ema;
  if (!nearEma20 && !betweenEmas && !aboveBothEmas) {
    return reject(`Not supported by EMA structure: ${trend.distanceFrom20EmaPct.toFixed(1)}% from EMA20`);
  }

  // ── Momentum in pullback band ─────────────────────────────
  if (momentum.rsi14 < 42) return reject(`RSI too weak: ${momentum.rsi14}`);
  if (momentum.rsi14 > 65) return reject(`RSI too hot for Fibonacci pullback: ${momentum.rsi14}`);

  // ── Volume not weak ───────────────────────────────────────
  if (volume.volumeVs20dAvg < MIN_VOLUME_RATIO) {
    return reject(`Volume too weak: ${volume.volumeVs20dAvg.toFixed(1)}x`);
  }

  // ── Fibonacci support intact ──────────────────────────────
  if (hasBrokenFibSupport(close, fib618, FIB_ZONE_TOLERANCE_PCT)) {
    return reject('Price broke below 61.8% Fibonacci support');
  }
  if (hasBrokenFibSupport(close, fib786, FIB_ZONE_TOLERANCE_PCT)) {
    return reject('Price broke below 78.6% Fibonacci support');
  }

  return { matched: true };
}

function hasBrokenFibSupport(
  close: number,
  level: number | undefined,
  tolerancePct: number,
): boolean {
  if (level === undefined || !Number.isFinite(level)) return false;
  if (level === 0) return close < 0;
  return close < level * (1 - tolerancePct / 100);
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
