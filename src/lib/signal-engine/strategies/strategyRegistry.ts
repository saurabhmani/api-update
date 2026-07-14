// ════════════════════════════════════════════════════════════════
//  Strategy Registry — Phase 1 stabilized
//
//  Central authority for all strategy metadata: allowed regimes,
//  scoring weights, parameter ranges, direction, plus the Phase-1
//  standardization fields (category, entryType, riskProfile,
//  explanationTemplate, invalidationLogic, idealMarketRegime).
//
//  Single source of truth — the trade-plan builder, API response
//  mapper, and dashboard renderer ALL read these fields. Adding a
//  new strategy means filling this map and nothing else.
// ════════════════════════════════════════════════════════════════

import type {
  StrategyName, StrategyRegistryEntry, MarketRegimeLabel,
  EntryType, StrategyCategory, StrategyMode,
  EnhancedMarketRegime, RegimeDimensions, StrategyRegimeMatrix,
  StrategyRegimeEligibilityResult, RegimeTrendState, RegimeVolatilityState,
  RegimeBreadthState, RegimeLiquidityState, RegimeTransitionState,
} from '../types/signalEngine.types';
import { getEffectiveStrategyEntryFields } from '@/lib/strategy-hub/effectiveStrategyConfig';
import {
  resolveEffectiveStrategyMode,
  canStrategyProduceConfirmedSignal,
} from './strategyModePolicy';
import { trendStateFromLabel } from '../regime/regimeDimensions';

export {
  resolveEffectiveStrategyMode,
  canStrategyProduceConfirmedSignal,
  applyStrategyModeCaps,
} from './strategyModePolicy';
export type {
  StrategyModeCapInput,
  StrategyModeCapResult,
  StrategyModeScoreContext,
} from './strategyModePolicy';

export const STRATEGY_REGISTRY: Record<StrategyName, StrategyRegistryEntry> = {
  // ── Breakout family ────────────────────────────────────────
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
    category:            'breakout',
    entryType:           'breakout_confirmation',
    riskProfile:         'moderate',
    timeframe:           'swing',
    signalType:          'bullish_breakout',
    strategyMode:        'CONFIRMED_ENABLED',
    explanationTemplate: 'Price closed above resistance with improving momentum. Approval requires volume confirmation and fresh candle validation.',
    invalidationLogic:   'Close below the prior resistance band invalidates the breakout structure.',
    idealMarketRegime:   ['Strong Bullish', 'Bullish'],
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
    category:            'breakout',
    entryType:           'range_breakout_confirmation',
    riskProfile:         'moderate',
    timeframe:           'swing',
    signalType:          'range_breakout',
    strategyMode:        'CONFIRMED_ENABLED',
    explanationTemplate: 'Price is breaking out of a tight consolidation range with expanding volume.',
    invalidationLogic:   'Re-entry into the prior range invalidates the breakout.',
    idealMarketRegime:   ['Sideways', 'Bullish'],
  },

  // ── Trend-following family ─────────────────────────────────
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
    category:            'trend_following',
    entryType:           'trend_crossover_entry',
    riskProfile:         'moderate',
    timeframe:           'swing',
    signalType:          'ema_crossover',
    strategyMode:        'CONFIRMED_ENABLED',
    scoreGatedWatchlist: true,
    explanationTemplate: 'Faster EMA has crossed above the slower EMA while broader trend remains constructive.',
    invalidationLogic:   'Close back below the slower EMA invalidates the crossover.',
    idealMarketRegime:   ['Bullish', 'Strong Bullish'],
  },

  // ── Momentum family ────────────────────────────────────────
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
    category:            'momentum',
    entryType:           'momentum_continuation_entry',
    riskProfile:         'moderate_high',
    timeframe:           'swing',
    signalType:          'momentum_continuation',
    strategyMode:        'CONFIRMED_ENABLED',
    explanationTemplate: 'Momentum continues in the direction of the prevailing trend; price is holding above short-term moving averages.',
    invalidationLogic:   'Loss of short-term trend support invalidates the continuation thesis.',
    idealMarketRegime:   ['Strong Bullish', 'Bullish'],
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
    category:            'momentum',
    entryType:           'gap_continuation_entry',
    riskProfile:         'moderate_high',
    timeframe:           'swing',
    signalType:          'gap_continuation',
    strategyMode:        'CONFIRMED_ENABLED',
    explanationTemplate: 'Price gapped in the trend direction and continues higher with sustained volume.',
    invalidationLogic:   'Fill of the opening gap invalidates the continuation setup.',
    idealMarketRegime:   ['Strong Bullish', 'Bullish'],
  },

  // ── Pullback family ────────────────────────────────────────
  bullish_pullback: {
    strategyId: 'bullish_pullback',
    displayName: 'Bullish Pullback',
    direction: 'long',
    allowedRegimes: ['Strong Bullish', 'Bullish', 'Sideways'],
    blockedRegimes: ['Bearish', 'High Volatility Risk'],
    idealRsiRange: [40, 65],
    defaultConfidenceWeight: 0.95,
    category:            'pullback',
    entryType:           'pullback_entry',
    riskProfile:         'moderate',
    timeframe:           'swing',
    signalType:          'bullish_pullback',
    strategyMode:        'CONFIRMED_ENABLED',
    explanationTemplate: 'Price is pulling back toward a rising moving average while the broader trend remains constructive.',
    invalidationLogic:   'Close below the rising moving average invalidates the pullback structure.',
    idealMarketRegime:   ['Strong Bullish', 'Bullish'],
  },

  fibonacci_pullback: {
    strategyId: 'fibonacci_pullback',
    displayName: 'Fibonacci Pullback',
    direction: 'long',
    allowedRegimes: ['Strong Bullish', 'Bullish'],
    blockedRegimes: ['Bearish', 'High Volatility Risk'],
    idealRsiRange: [42, 65],
    defaultConfidenceWeight: 0.95,
    category:            'pullback',
    entryType:           'pullback_entry',
    riskProfile:         'moderate',
    timeframe:           'swing',
    signalType:          'fibonacci_pullback',
    strategyMode:        'CONFIRMED_ENABLED',
    explanationTemplate: 'Price is reacting from a key Fibonacci retracement zone inside a bullish trend.',
    invalidationLogic:   'Close below the 61.8% or 78.6% Fibonacci support zone invalidates the setup.',
    idealMarketRegime:   ['Strong Bullish', 'Bullish'],
  },

  // ── Mean reversion family ──────────────────────────────────
  mean_reversion_bounce: {
    strategyId: 'mean_reversion_bounce',
    displayName: 'Mean Reversion Bounce',
    direction: 'long',
    allowedRegimes: ['Sideways', 'Weak', 'Bullish'],
    blockedRegimes: ['High Volatility Risk'],
    idealRsiRange: [15, 40],
    defaultConfidenceWeight: 0.8,
    category:            'mean_reversion',
    entryType:           'mean_reversion_entry',
    riskProfile:         'moderate_high',
    timeframe:           'swing',
    signalType:          'mean_reversion_bounce',
    strategyMode:        'WATCHLIST_ONLY',
    explanationTemplate: 'Price is recovering from an oversold zone, but confirmation is required before approval.',
    invalidationLogic:   'A fresh lower low without recovery invalidates the bounce setup.',
    idealMarketRegime:   ['Sideways', 'Weak'],
  },

  oversold_bounce: {
    strategyId: 'oversold_bounce',
    displayName: 'Oversold Bounce',
    direction: 'long',
    allowedRegimes: ['Sideways', 'Weak', 'Bearish', 'Bullish'],
    blockedRegimes: ['High Volatility Risk'],
    idealRsiRange: [10, 30],
    defaultConfidenceWeight: 0.7,
    category:            'mean_reversion',
    entryType:           'oversold_recovery_entry',
    riskProfile:         'moderate_high',
    timeframe:           'swing',
    signalType:          'oversold_bounce',
    strategyMode:        'WATCHLIST_ONLY',
    explanationTemplate: 'Oversold recovery detected with early momentum improvement, but confirmation remains pending.',
    invalidationLogic:   'Failure to reclaim the recent swing low invalidates the recovery.',
    idealMarketRegime:   ['Sideways', 'Weak'],
  },

  // ── Reversal family ────────────────────────────────────────
  bullish_divergence: {
    strategyId: 'bullish_divergence',
    displayName: 'Bullish Divergence',
    direction: 'long',
    allowedRegimes: ['Sideways', 'Weak', 'Bullish', 'Bearish'],
    blockedRegimes: ['High Volatility Risk'],
    idealRsiRange: [15, 50],
    defaultConfidenceWeight: 0.85,
    category:            'reversal',
    entryType:           'divergence_confirmation_entry',
    riskProfile:         'moderate_high',
    timeframe:           'swing',
    signalType:          'bullish_divergence',
    strategyMode:        'WATCHLIST_ONLY',
    explanationTemplate: 'Momentum is diverging upward against price weakness; reversal pending confirmation.',
    invalidationLogic:   'A fresh lower low in price without momentum support invalidates the divergence.',
    idealMarketRegime:   ['Weak', 'Sideways'],
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
    category:            'reversal',
    entryType:           'volume_climax_reversal_entry',
    riskProfile:         'high',
    timeframe:           'swing',
    signalType:          'volume_climax_reversal',
    strategyMode:        'WATCHLIST_ONLY',
    explanationTemplate: 'Capitulation volume into a low; potential exhaustion reversal pending confirmation.',
    invalidationLogic:   'A second climax low without reclaim invalidates the reversal.',
    idealMarketRegime:   ['Weak', 'Bearish'],
  },

  overbought_reversal: {
    strategyId: 'overbought_reversal',
    displayName: 'Overbought Reversal',
    direction: 'short',
    allowedRegimes: ['Sideways', 'Weak', 'Bearish', 'Bullish'],
    blockedRegimes: ['Strong Bullish', 'High Volatility Risk'],
    idealRsiRange: [68, 85],
    defaultConfidenceWeight: 0.75,
    category:            'reversal',
    entryType:           'overbought_reversal_entry',
    riskProfile:         'moderate_high',
    timeframe:           'swing',
    signalType:          'overbought_reversal',
    strategyMode:        'WATCHLIST_ONLY',
    explanationTemplate: 'Price is extended above short-term averages and showing reversal risk. This setup should remain watchlisted unless weakness confirms.',
    invalidationLogic:   'A fresh higher high invalidates the reversal — exit on close above the rejection wick.',
    idealMarketRegime:   ['Sideways', 'Weak'],
  },

  // ── Breakdown family ───────────────────────────────────────
  bearish_breakdown: {
    strategyId: 'bearish_breakdown',
    displayName: 'Bearish Breakdown',
    direction: 'short',
    allowedRegimes: ['Bearish', 'Weak', 'Sideways', 'High Volatility Risk'],
    blockedRegimes: ['Strong Bullish'],
    idealRsiRange: [15, 45],
    minVolumeExpansion: 1.2,
    defaultConfidenceWeight: 0.9,
    category:            'breakdown',
    entryType:           'breakdown_confirmation',
    riskProfile:         'high',
    timeframe:           'swing',
    signalType:          'bearish_breakdown',
    strategyMode:        'WATCHLIST_ONLY',
    explanationTemplate: 'Price is trading below support with weak trend structure. Risk gate will check follow-through and liquidity before approval.',
    invalidationLogic:   'Reclaim of the broken support invalidates the breakdown.',
    idealMarketRegime:   ['Bearish', 'Weak'],
  },

  weak_trend_breakdown: {
    strategyId: 'weak_trend_breakdown',
    displayName: 'Weak Trend Breakdown',
    direction: 'short',
    allowedRegimes: ['Sideways', 'Weak', 'Bearish', 'High Volatility Risk'],
    blockedRegimes: ['Strong Bullish'],
    idealRsiRange: [20, 58],
    minVolumeExpansion: 0.7,
    defaultConfidenceWeight: 0.85,
    category:            'breakdown',
    entryType:           'weak_trend_breakdown_entry',
    riskProfile:         'high',
    timeframe:           'swing',
    signalType:          'weak_trend_breakdown',
    strategyMode:        'WATCHLIST_ONLY',
    explanationTemplate: 'Trend structure is weakening and price is failing to reclaim short-term averages.',
    invalidationLogic:   'A reclaim of the prior swing high invalidates the breakdown structure.',
    idealMarketRegime:   ['Weak', 'Bearish'],
  },

  // ══ Phase 4A — Swing / daily strategies (EOD-data based) ══

  failed_breakout_reversal: {
    strategyId: 'failed_breakout_reversal',
    displayName: 'Failed Breakout Reversal',
    direction: 'short',
    allowedRegimes: ['Sideways', 'Weak', 'Bearish', 'High Volatility Risk', 'Bullish'],
    blockedRegimes: ['Strong Bullish'],
    idealRsiRange: [40, 75],
    minVolumeExpansion: 1.3,
    defaultConfidenceWeight: 0.85,
    category:            'reversal',
    entryType:           'failed_breakout_reversal_entry',
    riskProfile:         'high',
    timeframe:           'swing',
    signalType:          'failed_breakout_reversal',
    strategyMode:        'WATCHLIST_ONLY',
    explanationTemplate: 'Breakout attempt failed after price closed back below resistance, indicating possible bull-trap risk.',
    invalidationLogic:   'Setup invalidates if price reclaims and sustains above the failed breakout level.',
    idealMarketRegime:   ['Sideways', 'Weak'],
  },

  bearish_pullback_rejection: {
    strategyId: 'bearish_pullback_rejection',
    displayName: 'Bearish Pullback Rejection',
    direction: 'short',
    allowedRegimes: ['Weak', 'Bearish', 'High Volatility Risk', 'Sideways'],
    blockedRegimes: ['Strong Bullish'],
    idealRsiRange: [40, 65],
    minVolumeExpansion: 1.0,
    defaultConfidenceWeight: 0.85,
    category:            'breakdown',
    entryType:           'bearish_pullback_rejection_entry',
    riskProfile:         'high',
    timeframe:           'swing',
    signalType:          'bearish_pullback_rejection',
    strategyMode:        'WATCHLIST_ONLY',
    explanationTemplate: 'Price rallied into resistance within a weak trend and showed rejection, suggesting continuation risk.',
    invalidationLogic:   'Setup invalidates if price closes above the rejection / resistance zone.',
    idealMarketRegime:   ['Weak', 'Bearish'],
  },

  volatility_squeeze_breakout: {
    strategyId: 'volatility_squeeze_breakout',
    displayName: 'Volatility Squeeze Breakout',
    direction: 'long',
    allowedRegimes: ['Bullish', 'Strong Bullish', 'Sideways'],
    blockedRegimes: ['High Volatility Risk'],
    idealRsiRange: [45, 72],
    minVolumeExpansion: 1.4,
    defaultConfidenceWeight: 0.9,
    category:            'breakout',
    entryType:           'volatility_squeeze_breakout_entry',
    riskProfile:         'moderate',
    timeframe:           'swing',
    signalType:          'volatility_squeeze_breakout',
    strategyMode:        'CONFIRMED_ENABLED',
    explanationTemplate: 'Volatility compression resolved into a breakout with improving participation.',
    invalidationLogic:   'Setup invalidates if price re-enters the compression range.',
    idealMarketRegime:   ['Bullish', 'Sideways'],
  },

  // ══ Phase 4B — Confirmation / intraday-aware (data-gated) ══
  //
  // These are REGISTERED so the rest of the platform sees them as
  // first-class strategies. Their detectors honour the
  // `requiresIntradayData` / `isConfirmationOnly` flags and return
  // INSUFFICIENT_DATA when the underlying intraday / weekly data
  // isn't available — no fabrication.

  multi_timeframe_alignment: {
    strategyId: 'multi_timeframe_alignment',
    displayName: 'Multi-Timeframe Alignment',
    direction: 'neutral',
    allowedRegimes: ['Strong Bullish', 'Bullish', 'Sideways', 'Weak', 'Bearish'],
    blockedRegimes: ['High Volatility Risk'],
    idealRsiRange: [30, 70],
    defaultConfidenceWeight: 0.6,
    category:            'confirmation',
    entryType:           'multi_timeframe_confirmation_entry',
    riskProfile:         'conservative',
    timeframe:           'swing',
    signalType:          'multi_timeframe_alignment',
    strategyMode:        'DISABLED',
    explanationTemplate: 'Weekly trend, daily setup, and short-term confirmation are aligned.',
    invalidationLogic:   'Loss of weekly trend support invalidates the alignment.',
    idealMarketRegime:   ['Bullish', 'Strong Bullish'],
    isConfirmationOnly:  true,
  },

  vwap_reclaim_long: {
    strategyId: 'vwap_reclaim_long',
    displayName: 'VWAP Reclaim Long',
    direction: 'long',
    allowedRegimes: ['Strong Bullish', 'Bullish', 'Sideways'],
    blockedRegimes: ['Bearish'],
    idealRsiRange: [40, 70],
    defaultConfidenceWeight: 0.8,
    category:            'intraday_confirmation',
    entryType:           'vwap_reclaim_entry',
    riskProfile:         'moderate',
    timeframe:           'intraday',
    signalType:          'vwap_reclaim_long',
    strategyMode:        'DISABLED',
    explanationTemplate: 'Price reclaimed VWAP with improving participation, supporting short-term bullish confirmation.',
    invalidationLogic:   'A close back below VWAP with rising volume invalidates the reclaim.',
    idealMarketRegime:   ['Bullish', 'Strong Bullish'],
    requiresIntradayData: true,
  },

  vwap_rejection_short: {
    strategyId: 'vwap_rejection_short',
    displayName: 'VWAP Rejection Short',
    direction: 'short',
    allowedRegimes: ['Weak', 'Bearish', 'Sideways'],
    blockedRegimes: ['Strong Bullish'],
    idealRsiRange: [30, 60],
    defaultConfidenceWeight: 0.8,
    category:            'intraday_confirmation',
    entryType:           'vwap_rejection_entry',
    riskProfile:         'moderate_high',
    timeframe:           'intraday',
    signalType:          'vwap_rejection_short',
    strategyMode:        'DISABLED',
    explanationTemplate: 'Price rejected VWAP after a weak retest, supporting short-term bearish continuation.',
    invalidationLogic:   'A clean reclaim above VWAP invalidates the rejection.',
    idealMarketRegime:   ['Weak', 'Bearish'],
    requiresIntradayData: true,
  },

  opening_range_breakout: {
    strategyId: 'opening_range_breakout',
    displayName: 'Opening Range Breakout',
    direction: 'long',
    allowedRegimes: ['Strong Bullish', 'Bullish', 'Sideways'],
    blockedRegimes: ['Bearish'],
    idealRsiRange: [45, 75],
    minVolumeExpansion: 1.3,
    defaultConfidenceWeight: 0.85,
    category:            'intraday_breakout',
    entryType:           'opening_range_breakout_entry',
    riskProfile:         'moderate',
    timeframe:           'intraday',
    signalType:          'opening_range_breakout',
    strategyMode:        'DISABLED',
    explanationTemplate: 'Price broke above the opening range with participation and VWAP support.',
    invalidationLogic:   'A return back inside the opening range invalidates the breakout.',
    idealMarketRegime:   ['Strong Bullish', 'Bullish'],
    requiresIntradayData: true,
  },

  opening_range_breakdown: {
    strategyId: 'opening_range_breakdown',
    displayName: 'Opening Range Breakdown',
    direction: 'short',
    allowedRegimes: ['Weak', 'Bearish', 'Sideways', 'High Volatility Risk'],
    blockedRegimes: ['Strong Bullish'],
    idealRsiRange: [25, 55],
    minVolumeExpansion: 1.3,
    defaultConfidenceWeight: 0.85,
    category:            'intraday_breakdown',
    entryType:           'opening_range_breakdown_entry',
    riskProfile:         'high',
    timeframe:           'intraday',
    signalType:          'opening_range_breakdown',
    strategyMode:        'DISABLED',
    explanationTemplate: 'Price broke below the opening range with weak structure and selling participation.',
    invalidationLogic:   'A reclaim into the opening range invalidates the breakdown.',
    idealMarketRegime:   ['Weak', 'Bearish'],
    requiresIntradayData: true,
  },
};

/**
 * Check if a strategy is allowed in the given market regime (legacy label).
 * Prefer evaluateStrategyRegimeEligibility when structured dimensions exist.
 */
export function isStrategyAllowedInRegime(
  strategy: StrategyName,
  regime: MarketRegimeLabel,
): { allowed: boolean; reason?: string; dimension?: string; rule?: string } {
  const result = evaluateStrategyRegimeEligibility(strategy, { label: regime });
  return {
    allowed: result.allowed,
    reason: result.reason,
    dimension: result.dimension,
    rule: result.rule,
  };
}

/**
 * Phase 3 — sole strategy↔regime eligibility authority.
 * Rejection reasons always identify the dimension + rule.
 */
export function evaluateStrategyRegimeEligibility(
  strategy: StrategyName,
  regime: {
    label: MarketRegimeLabel;
    dimensions?: RegimeDimensions;
    hysteresis?: { confirmationBarsHeld: number; changed: boolean; minConfirmationBars?: number };
  },
): StrategyRegimeEligibilityResult {
  const entry = STRATEGY_REGISTRY[strategy];
  if (!entry) {
    return {
      allowed: false,
      reason: `Unknown strategy: ${strategy}`,
      dimension: 'label',
      rule: 'not_allowed',
      confidencePenalty: 0,
      ideal: false,
    };
  }

  const effective = getEffectiveStrategyEntryFields(strategy) ?? entry;
  const matrix = entry.regimeMatrix ?? deriveRegimeMatrix(entry);

  if (effective.blockedRegimes.includes(regime.label)) {
    return {
      allowed: false,
      reason: `${entry.displayName} blocked by label rule: ${regime.label}`,
      dimension: 'label',
      rule: 'blocked',
      confidencePenalty: 0,
      ideal: false,
    };
  }

  if (!effective.allowedRegimes.includes(regime.label)) {
    return {
      allowed: false,
      reason: `${entry.displayName} not allowed in ${regime.label} (allowed: ${effective.allowedRegimes.join(', ')})`,
      dimension: 'label',
      rule: 'not_allowed',
      confidencePenalty: 0,
      ideal: false,
    };
  }

  const dims: RegimeDimensions = regime.dimensions ?? {
    trend_state: trendStateFromLabel(regime.label),
    volatility_state: regime.label === 'High Volatility Risk' ? 'extreme' : 'normal',
    breadth_state: 'selective',
    liquidity_state: 'healthy',
    transition_state: 'stable',
  };

  // Dimension blocked
  for (const key of Object.keys(matrix.blocked) as (keyof typeof matrix.blocked)[]) {
    const blockedVals = matrix.blocked[key];
    if (!blockedVals || blockedVals.length === 0) continue;
    const current = dims[key] as string;
    if (blockedVals.includes(current as never)) {
      return {
        allowed: false,
        reason: `${entry.displayName} blocked: ${key}=${current}`,
        dimension: key,
        rule: 'blocked',
        confidencePenalty: 0,
        ideal: false,
      };
    }
  }

  // Dimension allowed lists (when declared)
  for (const key of Object.keys(matrix.allowed) as (keyof typeof matrix.allowed)[]) {
    const allowedVals = matrix.allowed[key];
    if (!allowedVals || allowedVals.length === 0) continue;
    const current = dims[key] as string;
    if (!allowedVals.includes(current as never)) {
      return {
        allowed: false,
        reason: `${entry.displayName} not allowed: ${key}=${current} (allowed: ${allowedVals.join(', ')})`,
        dimension: key,
        rule: 'not_allowed',
        confidencePenalty: 0,
        ideal: false,
      };
    }
  }

  if (matrix.requiredTransitionStates && matrix.requiredTransitionStates.length > 0) {
    if (!matrix.requiredTransitionStates.includes(dims.transition_state)) {
      return {
        allowed: false,
        reason: `${entry.displayName} requires transition_state in [${matrix.requiredTransitionStates.join(', ')}] (got ${dims.transition_state})`,
        dimension: 'transition_state',
        rule: 'transition',
        confidencePenalty: 0,
        ideal: false,
      };
    }
  }

  const needBars = matrix.requiredTransitionConfirmationBars ?? 0;
  if (needBars > 0 && regime.hysteresis) {
    const held = regime.hysteresis.confirmationBarsHeld;
    if (regime.hysteresis.changed === false && held > 0 && held < needBars) {
      return {
        allowed: false,
        reason: `${entry.displayName} awaiting transition confirmation ${held}/${needBars}`,
        dimension: 'transition_confirmation',
        rule: 'transition',
        confidencePenalty: 0,
        ideal: false,
      };
    }
  }

  // Ideal check → penalty when allowed but non-ideal
  let ideal = true;
  for (const key of Object.keys(matrix.ideal) as (keyof typeof matrix.ideal)[]) {
    const idealVals = matrix.ideal[key];
    if (!idealVals || idealVals.length === 0) continue;
    const current = dims[key] as string;
    if (!idealVals.includes(current as never)) {
      ideal = false;
      break;
    }
  }
  if (ideal && entry.idealMarketRegime.length > 0 && !entry.idealMarketRegime.includes(regime.label)) {
    ideal = false;
  }

  const penalty = ideal ? 0 : matrix.nonIdealConfidencePenalty;

  return {
    allowed: true,
    confidencePenalty: penalty,
    ideal,
    rule: penalty > 0 ? 'ideal_penalty' : undefined,
    reason: penalty > 0
      ? `${entry.displayName} permitted but non-ideal (penalty ${penalty})`
      : undefined,
  };
}

/** Derive dimension matrix from legacy label arrays when not explicitly set. */
export function deriveRegimeMatrix(entry: StrategyRegistryEntry): StrategyRegimeMatrix {
  const mapTrend = (labels: MarketRegimeLabel[]): RegimeTrendState[] =>
    Array.from(new Set(labels.filter((l) => l !== 'High Volatility Risk').map(trendStateFromLabel)));

  const blockedVol: RegimeVolatilityState[] = entry.blockedRegimes.includes('High Volatility Risk')
    ? ['extreme']
    : [];

  const idealTrend = mapTrend(entry.idealMarketRegime);
  const allowedTrend = mapTrend(entry.allowedRegimes);

  return {
    ideal: {
      trend_state: idealTrend.length ? idealTrend : undefined,
      volatility_state: ['compressed', 'normal'],
      transition_state: ['stable', 'emerging'],
    },
    allowed: {
      trend_state: allowedTrend.length ? allowedTrend : undefined,
      volatility_state: blockedVol.length
        ? (['compressed', 'normal', 'elevated'] as RegimeVolatilityState[])
        : undefined,
      liquidity_state: ['healthy', 'thin'] as RegimeLiquidityState[],
    },
    blocked: {
      volatility_state: blockedVol.length ? blockedVol : undefined,
      liquidity_state: ['stressed'] as RegimeLiquidityState[],
      breadth_state: entry.direction === 'long'
        ? (['capitulation'] as RegimeBreadthState[])
        : undefined,
    },
    nonIdealConfidencePenalty: 5,
    requiredTransitionStates: undefined,
    requiredTransitionConfirmationBars: 0,
  };
}

/**
 * Get all strategies that are allowed for a given regime.
 */
export function getStrategiesForRegime(regime: MarketRegimeLabel): StrategyName[] {
  return (Object.keys(STRATEGY_REGISTRY) as StrategyName[]).filter(
    (name) => isStrategyAllowedInRegime(name, regime).allowed,
  );
}

export function getStrategiesForStructuredRegime(
  regime: Pick<EnhancedMarketRegime, 'label' | 'dimensions' | 'hysteresis'>,
): StrategyName[] {
  return (Object.keys(STRATEGY_REGISTRY) as StrategyName[]).filter(
    (name) => evaluateStrategyRegimeEligibility(name, regime).allowed,
  );
}

/**
 * Get the registry entry for a strategy.
 */
export function getStrategyEntry(name: StrategyName): StrategyRegistryEntry {
  return STRATEGY_REGISTRY[name];
}

// ── Phase-1 stabilization accessors ──────────────────────────
//
// These are the single-source readers every downstream consumer
// (trade-plan builder, API response mapper, dashboard renderer)
// should use to surface strategy metadata. Each accepts a raw
// strategy ID (string from the DB) and returns a typed, never-null
// value with a safe fallback so the UI can't render undefined / "—".

/** Display name with safe fallback. */
export function getStrategyDisplayName(strategy: StrategyName | string | null | undefined): string {
  if (!strategy) return 'Unclassified setup';
  const entry = STRATEGY_REGISTRY[strategy as StrategyName];
  if (entry) return entry.displayName;
  // Unknown strategy ID — humanise the snake_case so something
  // sensible still renders ("custom_breakout" → "Custom Breakout").
  return String(strategy)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Strategy category with safe fallback. */
export function getStrategyCategory(strategy: StrategyName | string | null | undefined): StrategyCategory {
  if (!strategy) return 'breakout';
  const entry = STRATEGY_REGISTRY[strategy as StrategyName];
  return entry?.category ?? 'breakout';
}

/** Strategy-specific entry type. Returns the fallback only when the
 *  strategy ID is unknown — never for a registered strategy. */
export function getStrategyEntryType(strategy: StrategyName | string | null | undefined): EntryType {
  if (!strategy) return 'strategy_confirmation_entry';
  const entry = STRATEGY_REGISTRY[strategy as StrategyName];
  if (!entry) {
    // Operator-visible warning — fallback is meant to be rare.
    if (typeof console !== 'undefined') {
      console.warn(`[strategyRegistry] entryType fallback applied for unknown strategy "${strategy}".`);
    }
    return 'strategy_confirmation_entry';
  }
  return entry.entryType;
}

/** Direction in BUY/SELL form for wire/UI consumers. */
export function getStrategyDirectionLabel(strategy: StrategyName | string | null | undefined): 'BUY' | 'SELL' {
  if (!strategy) return 'BUY';
  const entry = STRATEGY_REGISTRY[strategy as StrategyName];
  return entry?.direction === 'short' ? 'SELL' : 'BUY';
}

/** Operator-facing explanation template. Falls back to the displayName. */
export function getStrategyExplanation(strategy: StrategyName | string | null | undefined): string {
  if (!strategy) return 'Strategy setup detected — confirmation pending.';
  const entry = STRATEGY_REGISTRY[strategy as StrategyName];
  return entry?.explanationTemplate
    ?? `${getStrategyDisplayName(strategy)} setup detected — confirmation pending.`;
}

/** Plain-language invalidation rule. */
export function getStrategyInvalidation(strategy: StrategyName | string | null | undefined): string {
  if (!strategy) return 'Stop-loss breach invalidates the setup.';
  const entry = STRATEGY_REGISTRY[strategy as StrategyName];
  return entry?.invalidationLogic ?? 'Stop-loss breach invalidates the setup.';
}

/** Registry-declared strategy mode (before score-gating). */
export function getStrategyMode(strategy: StrategyName | string | null | undefined): StrategyMode {
  if (!strategy) return 'CONFIRMED_ENABLED';
  const entry = STRATEGY_REGISTRY[strategy as StrategyName];
  return entry?.strategyMode ?? 'CONFIRMED_ENABLED';
}

/** Bundled metadata reader — useful when a caller needs everything
 *  at once (e.g. the API response mapper). */
export function getStrategyMeta(strategy: StrategyName | string | null | undefined): {
  strategyId:        string;
  strategyName:      string;
  strategyCategory:  StrategyCategory;
  entryType:         EntryType;
  direction:         'BUY' | 'SELL';
  explanation:       string;
  invalidation:      string;
  strategyMode:      StrategyMode;
  effectiveStrategyMode?: StrategyMode;
} {
  const mode = getStrategyMode(strategy);
  return {
    strategyId:       strategy ? String(strategy) : 'unclassified',
    strategyName:     getStrategyDisplayName(strategy),
    strategyCategory: getStrategyCategory(strategy),
    entryType:        getStrategyEntryType(strategy),
    direction:        getStrategyDirectionLabel(strategy),
    explanation:      getStrategyExplanation(strategy),
    invalidation:     getStrategyInvalidation(strategy),
    strategyMode:     mode,
    effectiveStrategyMode: resolveEffectiveStrategyMode(strategy),
  };
}
