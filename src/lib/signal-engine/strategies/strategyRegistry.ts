// ════════════════════════════════════════════════════════════════
//  Strategy Registry — Phase 2
//
//  Central registry of all strategy metadata: allowed regimes,
//  scoring weights, parameter ranges, direction. Used by the
//  strategy engine for regime-gating and parameter adaptation.
// ════════════════════════════════════════════════════════════════

import type {
  StrategyName, StrategyRegistryEntry, MarketRegimeLabel,
} from '../types/signalEngine.types';

export const STRATEGY_REGISTRY: Record<StrategyName, StrategyRegistryEntry> = {
  bullish_breakout: {
    strategyId: 'bullish_breakout',
    displayName: 'Bullish Breakout',
    direction: 'long',
    allowedRegimes: ['Strong Bullish', 'Bullish'],
    blockedRegimes: ['Bearish', 'High Volatility Risk'],
    minAdx: 20,
    idealRsiRange: [55, 72],
    minVolumeExpansion: 1.5,
    defaultConfidenceWeight: 1.0,
  },

  momentum_continuation: {
    strategyId: 'momentum_continuation',
    displayName: 'Momentum Continuation',
    direction: 'long',
    allowedRegimes: ['Strong Bullish', 'Bullish'],
    blockedRegimes: ['Bearish', 'Weak', 'High Volatility Risk'],
    minAdx: 25,
    idealRsiRange: [60, 78],
    minVolumeExpansion: 0.8,
    defaultConfidenceWeight: 1.0,
  },

  gap_continuation: {
    strategyId: 'gap_continuation',
    displayName: 'Gap Continuation',
    direction: 'long',
    allowedRegimes: ['Strong Bullish', 'Bullish'],
    blockedRegimes: ['Bearish', 'Weak', 'High Volatility Risk'],
    idealRsiRange: [50, 78],
    minVolumeExpansion: 1.5,
    defaultConfidenceWeight: 0.9,
  },

  bullish_pullback: {
    strategyId: 'bullish_pullback',
    displayName: 'Bullish Pullback',
    direction: 'long',
    allowedRegimes: ['Strong Bullish', 'Bullish', 'Sideways'],
    blockedRegimes: ['Bearish', 'High Volatility Risk'],
    idealRsiRange: [40, 65],
    defaultConfidenceWeight: 0.95,
  },

  bearish_breakdown: {
    strategyId: 'bearish_breakdown',
    displayName: 'Bearish Breakdown',
    direction: 'short',
    allowedRegimes: ['Bearish', 'Weak', 'Sideways', 'High Volatility Risk'],
    blockedRegimes: ['Strong Bullish'],
    idealRsiRange: [15, 45],
    minVolumeExpansion: 1.2,
    defaultConfidenceWeight: 0.9,
  },

  mean_reversion_bounce: {
    strategyId: 'mean_reversion_bounce',
    displayName: 'Mean Reversion Bounce',
    direction: 'long',
    allowedRegimes: ['Sideways', 'Weak', 'Bullish'],
    blockedRegimes: ['High Volatility Risk'],
    idealRsiRange: [15, 40],
    defaultConfidenceWeight: 0.8,
  },

  bullish_divergence: {
    strategyId: 'bullish_divergence',
    displayName: 'Bullish Divergence',
    direction: 'long',
    allowedRegimes: ['Sideways', 'Weak', 'Bullish', 'Bearish'],
    blockedRegimes: ['High Volatility Risk'],
    idealRsiRange: [15, 50],
    defaultConfidenceWeight: 0.85,
  },

  volume_climax_reversal: {
    strategyId: 'volume_climax_reversal',
    displayName: 'Volume Climax Reversal',
    direction: 'long',
    allowedRegimes: ['Weak', 'Bearish', 'Sideways'],
    blockedRegimes: ['High Volatility Risk'],
    idealRsiRange: [10, 35],
    minVolumeExpansion: 3.0,
    defaultConfidenceWeight: 0.75,
  },

  range_breakout: {
    strategyId: 'range_breakout',
    displayName: 'Range Breakout',
    direction: 'long',
    allowedRegimes: ['Sideways', 'Bullish', 'Strong Bullish'],
    blockedRegimes: ['High Volatility Risk'],
    idealRsiRange: [45, 70],
    minVolumeExpansion: 1.3,
    defaultConfidenceWeight: 0.9,
  },

  ema_crossover: {
    strategyId: 'ema_crossover',
    displayName: 'EMA Crossover',
    direction: 'long',
    allowedRegimes: ['Bullish', 'Strong Bullish', 'Sideways'],
    blockedRegimes: ['Bearish', 'High Volatility Risk'],
    minAdx: 18,
    idealRsiRange: [45, 75],
    minVolumeExpansion: 0.8,
    defaultConfidenceWeight: 0.85,
  },

  oversold_bounce: {
    strategyId: 'oversold_bounce',
    displayName: 'Oversold Bounce',
    direction: 'long',
    allowedRegimes: ['Sideways', 'Weak', 'Bearish', 'Bullish'],
    blockedRegimes: ['High Volatility Risk'],
    idealRsiRange: [10, 30],
    defaultConfidenceWeight: 0.7,
  },

  overbought_reversal: {
    strategyId: 'overbought_reversal',
    displayName: 'Overbought Reversal',
    direction: 'short',
    // Mirror of oversold_bounce — allowed in the same regime set
    // (sideways/trending/weak) but NOT in Strong Bullish (fighting
    // a roaring trend is how you bleed).
    allowedRegimes: ['Sideways', 'Weak', 'Bearish', 'Bullish'],
    blockedRegimes: ['Strong Bullish', 'High Volatility Risk'],
    idealRsiRange: [68, 85],
    defaultConfidenceWeight: 0.75,
  },

  weak_trend_breakdown: {
    strategyId: 'weak_trend_breakdown',
    displayName: 'Weak Trend Breakdown',
    direction: 'short',
    // Wider regime tolerance than bearish_breakdown — this strategy
    // looks for sustained weakness, not a fresh breakdown trigger,
    // so it's safe in Sideways + mildly bearish tapes.
    allowedRegimes: ['Sideways', 'Weak', 'Bearish', 'High Volatility Risk'],
    blockedRegimes: ['Strong Bullish'],
    idealRsiRange: [20, 58],
    minVolumeExpansion: 0.7,
    defaultConfidenceWeight: 0.85,
  },
};

/**
 * Check if a strategy is allowed in the given market regime.
 */
export function isStrategyAllowedInRegime(
  strategy: StrategyName,
  regime: MarketRegimeLabel,
): { allowed: boolean; reason?: string } {
  const entry = STRATEGY_REGISTRY[strategy];
  if (!entry) {
    return { allowed: false, reason: `Unknown strategy: ${strategy}` };
  }

  if (entry.blockedRegimes.includes(regime)) {
    return {
      allowed: false,
      reason: `${entry.displayName} is blocked in ${regime} regime`,
    };
  }

  if (!entry.allowedRegimes.includes(regime)) {
    return {
      allowed: false,
      reason: `${entry.displayName} not allowed in ${regime} regime (allowed: ${entry.allowedRegimes.join(', ')})`,
    };
  }

  return { allowed: true };
}

/**
 * Get all strategies that are allowed for a given regime.
 */
export function getStrategiesForRegime(regime: MarketRegimeLabel): StrategyName[] {
  return (Object.keys(STRATEGY_REGISTRY) as StrategyName[]).filter(
    (name) => isStrategyAllowedInRegime(name, regime).allowed,
  );
}

/**
 * Get the registry entry for a strategy.
 */
export function getStrategyEntry(name: StrategyName): StrategyRegistryEntry {
  return STRATEGY_REGISTRY[name];
}
