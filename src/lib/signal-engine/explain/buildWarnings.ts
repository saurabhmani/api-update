// ════════════════════════════════════════════════════════════════
//  Warnings Generator — Phase 1 + Phase 2
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyName } from '../types/signalEngine.types';
import { round } from '../utils/math';

export function buildWarnings(features: SignalFeatures, strategy?: StrategyName): string[] {
  const { trend, momentum, volatility, structure } = features;
  const warnings: string[] = [];

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
