// ════════════════════════════════════════════════════════════════
//  Warnings Generator — Phase 1 + Phase 2
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyName } from '../types/signalEngine.types';
import { round } from '../utils/math';
import { isPriceNearFibLevel } from '../indicators/fibonacci';

const FIB_WARNING_TOLERANCE_PCT = 1;
const FIB_MIN_VOLUME_RATIO = 0.8;
const FIB_PULLBACK_RSI_HIGH = 65;

function isBelowFibLevel(close: number, level: number | undefined, tolerancePct: number): boolean {
  if (level === undefined || !Number.isFinite(level)) return false;
  if (level === 0) return close < 0;
  return close < level * (1 - tolerancePct / 100);
}

export function buildWarnings(features: SignalFeatures, strategy?: StrategyName): string[] {
  const { trend, momentum, volatility, structure, volume, context } = features;
  const warnings: string[] = [];

  if (strategy === 'fibonacci_pullback') {
    const tol = structure.fibTolerancePct ?? FIB_WARNING_TOLERANCE_PCT;
    const { fib382, fib50, fib618, fib786 } = structure;
    const inGoldenZone = structure.fibZoneMatched === true;
    const nearKeyFib =
      (fib382 !== undefined && isPriceNearFibLevel(trend.close, fib382, tol))
      || (fib50 !== undefined && isPriceNearFibLevel(trend.close, fib50, tol))
      || (fib618 !== undefined && isPriceNearFibLevel(trend.close, fib618, tol))
      || (fib786 !== undefined && isPriceNearFibLevel(trend.close, fib786, tol));

    if (!inGoldenZone || !nearKeyFib) {
      warnings.push('Price is outside the volatility-aware Fibonacci zone.');
    }
    if (volume.volumeVs20dAvg < FIB_MIN_VOLUME_RATIO) {
      warnings.push('Fibonacci setup is weak because volume confirmation is missing.');
    }
    if (isBelowFibLevel(trend.close, fib618, tol) || isBelowFibLevel(trend.close, fib786, tol)) {
      warnings.push('Setup is invalid if price closes below 61.8% or 78.6% retracement.');
    }
    if (structure.fibSwingLow != null && trend.close < structure.fibSwingLow) {
      warnings.push('Impulse swing-low anchor is broken — setup invalidated.');
    }
    if (momentum.rsi14 > FIB_PULLBACK_RSI_HIGH) {
      warnings.push(`RSI at ${round(momentum.rsi14)} is overbought for a Fibonacci pullback entry`);
    }
    if (
      context.marketRegime === 'Bearish'
      || context.marketRegime === 'Sideways'
      || context.marketRegime === 'Weak'
      || context.marketRegime === 'High Volatility Risk'
    ) {
      warnings.push(
        `Market regime is ${context.marketRegime} — Fibonacci pullback is disabled or heavily reduced`,
      );
    }
  }

  // Overextension
  if (trend.distanceFrom20EmaPct > 3) {
    warnings.push(
      `Stock is ${round(trend.distanceFrom20EmaPct, 1)}% extended from the 20 EMA`,
    );
  }

  // Gap risk
  if (Math.abs(volatility.gapPct) > 1.5) {
    warnings.push(
      `Opening gap of ${round(volatility.gapPct, 1)}% is higher than normal`,
    );
  }

  // ATR elevated
  if (volatility.atrPct > 3) {
    warnings.push(
      `Daily volatility (ATR) is elevated at ${round(volatility.atrPct, 1)}% of price`,
    );
  }

  // RSI approaching overbought
  if (momentum.rsi14 > 68) {
    warnings.push('Momentum is approaching overbought territory');
  }

  // Bearish divergence
  if (momentum.bearishDivergence) {
    warnings.push('Bearish divergence detected — price may be topping despite new highs');
  }

  // Breakout extension
  if (structure.breakoutDistancePct > 2.5) {
    warnings.push(
      `Breakout is ${round(structure.breakoutDistancePct, 1)}% above resistance — late entry risk`,
    );
  }

  // High daily range
  if (volatility.dailyRangePct > 3.5) {
    warnings.push('Intraday range is wider than typical, suggesting elevated volatility');
  }

  // Distance from 50 EMA
  if (trend.distanceFrom50EmaPct > 6) {
    warnings.push(
      `Price is ${round(trend.distanceFrom50EmaPct, 1)}% above the 50 EMA — mean reversion risk`,
    );
  }

  // Stochastic overbought
  if (momentum.stochasticK > 85) {
    warnings.push('Stochastic oscillator in extreme overbought zone');
  }

  // Low ADX (no clear trend)
  if (momentum.adx < 20 && strategy && ['bullish_breakout', 'momentum_continuation'].includes(strategy)) {
    warnings.push(`ADX at ${round(momentum.adx)} — trend strength is weak`);
  }

  // OBV diverging from price
  if (features.volume.obvSlope < -5 && trend.closeAbove20Ema) {
    warnings.push('On-Balance Volume declining despite price strength — watch for distribution');
  }

  // Bollinger at upper band
  if (volatility.bollingerPctB > 0.95) {
    warnings.push('Price at upper Bollinger Band — may face resistance');
  }

  // Inside day before breakout
  if (structure.isInsideDay) {
    warnings.push('Inside day pattern — wait for directional confirmation');
  }

  return warnings;
}
