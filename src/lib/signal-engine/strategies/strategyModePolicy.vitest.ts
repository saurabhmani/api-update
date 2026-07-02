import { describe, it, expect } from 'vitest';
import {
  resolveEffectiveStrategyMode,
  canStrategyProduceConfirmedSignal,
  applyStrategyModeCaps,
  EMA_CROSSOVER_CONFIRMED_MIN_CONFIDENCE,
  EMA_CROSSOVER_CONFIRMED_MIN_FINAL,
} from './strategyModePolicy';
import { STRATEGY_REGISTRY } from './strategyRegistry';
import type { StrategyName } from '../types/signalEngine.types';

describe('strategyModePolicy', () => {
  it('assigns strategyMode to every registry entry', () => {
    for (const id of Object.keys(STRATEGY_REGISTRY) as StrategyName[]) {
      expect(STRATEGY_REGISTRY[id].strategyMode).toBeDefined();
    }
  });

  it('CONFIRMED_ENABLED strategies may produce confirmed signals', () => {
    expect(canStrategyProduceConfirmedSignal('bullish_breakout')).toBe(true);
    expect(canStrategyProduceConfirmedSignal('volatility_squeeze_breakout')).toBe(true);
  });

  it('WATCHLIST_ONLY strategies cannot produce confirmed signals', () => {
    expect(canStrategyProduceConfirmedSignal('mean_reversion_bounce')).toBe(false);
    expect(canStrategyProduceConfirmedSignal('bearish_breakdown')).toBe(false);
  });

  it('DISABLED intraday strategies cannot produce confirmed signals', () => {
    expect(canStrategyProduceConfirmedSignal('vwap_reclaim_long')).toBe(false);
    expect(canStrategyProduceConfirmedSignal('opening_range_breakout')).toBe(false);
  });

  it('ema_crossover is score-gated between CONFIRMED_ENABLED and WATCHLIST_ONLY', () => {
    expect(resolveEffectiveStrategyMode('ema_crossover', {
      finalScore: EMA_CROSSOVER_CONFIRMED_MIN_FINAL,
      confidenceScore: EMA_CROSSOVER_CONFIRMED_MIN_CONFIDENCE,
    })).toBe('CONFIRMED_ENABLED');

    expect(resolveEffectiveStrategyMode('ema_crossover', {
      finalScore: EMA_CROSSOVER_CONFIRMED_MIN_FINAL - 1,
      confidenceScore: EMA_CROSSOVER_CONFIRMED_MIN_CONFIDENCE,
    })).toBe('WATCHLIST_ONLY');
  });

  it('caps WATCHLIST_ONLY strategy classification to watchlist band', () => {
    const result = applyStrategyModeCaps({
      strategy: 'oversold_bounce',
      phase4Classification: 'VALID_SIGNAL',
      signalStatus: 'APPROVED_SIGNAL',
      rejectionFinalDecision: 'approved',
      executionApprovalDecision: 'approved',
      confidenceScore: 70,
      finalScore: 68,
    });

    expect(result.capped).toBe(true);
    expect(result.phase4Classification).toBe('WATCHLIST_ONLY');
    expect(result.signalStatus).toBe('DEVELOPING_SETUP');
    expect(result.rejectionFinalDecision).toBe('deferred');
    expect(result.executionApprovalDecision).toBe('deferred');
  });

  it('leaves CONFIRMED_ENABLED strategies unchanged', () => {
    const result = applyStrategyModeCaps({
      strategy: 'bullish_breakout',
      phase4Classification: 'HIGH_CONVICTION',
      signalStatus: 'APPROVED_SIGNAL',
      rejectionFinalDecision: 'approved',
      executionApprovalDecision: 'approved',
      confidenceScore: 80,
      finalScore: 78,
    });

    expect(result.capped).toBe(false);
    expect(result.phase4Classification).toBe('HIGH_CONVICTION');
    expect(result.signalStatus).toBe('APPROVED_SIGNAL');
  });

  it('unknown strategy IDs default to CONFIRMED_ENABLED for backward compatibility', () => {
    expect(resolveEffectiveStrategyMode('custom_legacy_strategy')).toBe('CONFIRMED_ENABLED');
  });
});
