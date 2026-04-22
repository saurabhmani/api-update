// ════════════════════════════════════════════════════════════════
//  Range Breakout Strategy
//
//  Detects stocks breaking out of a defined price range (consolidation).
//  Different from bullish_breakout: this looks for tight range compression
//  followed by an expansion bar, regardless of prior trend direction.
//
//  Entry: price closes above range high with volume confirmation
//  Works in: Sideways, Bullish, Strong Bullish regimes
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

export function evaluateRangeBreakout(features: SignalFeatures): StrategyMatchResult {
  const { trend, momentum, volume, volatility, structure, context } = features;

  if (!context.liquidityPass) return reject('Liquidity filter failed');

  const allowedRegimes = ['Sideways', 'Bullish', 'Strong Bullish'];
  if (!allowedRegimes.includes(context.marketRegime)) {
    return reject(`Regime not allowed: ${context.marketRegime}`);
  }

  // Range compression: ATR% below 2.5% indicates tight consolidation
  if (volatility.atrPct > 2.5) {
    return reject(`Volatility too high for range breakout: ATR% ${volatility.atrPct.toFixed(1)}`);
  }

  // Price must close above 20-day resistance
  if (trend.close <= structure.recentResistance20) {
    return reject('Price below range resistance');
  }

  // Volume must expand on breakout (at least 1.3x)
  if (volume.volumeVs20dAvg < 1.3) {
    return reject(`Volume expansion weak: ${volume.volumeVs20dAvg.toFixed(1)}x`);
  }

  // RSI should not be extreme (avoid chasing)
  if (momentum.rsi14 > 78) {
    return reject(`RSI overbought: ${momentum.rsi14.toFixed(0)}`);
  }

  // Range width: high-low spread over 20 days should be < 15%
  const rangeWidth = structure.recentResistance20 > 0
    ? ((structure.recentResistance20 - structure.recentSupport20) / structure.recentResistance20) * 100
    : 0;
  if (rangeWidth > 15) {
    return reject(`Range too wide: ${rangeWidth.toFixed(1)}% (max 15%)`);
  }

  return { matched: true };
}

function reject(reason: string): StrategyMatchResult {
  return { matched: false, rejectionReason: reason };
}
