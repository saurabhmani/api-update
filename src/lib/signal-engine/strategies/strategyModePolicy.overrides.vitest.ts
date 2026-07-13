import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveEffectiveStrategyMode,
  canStrategyProduceConfirmedSignal,
  setStrategyModeOverrideResolver,
  clearStrategyModeOverrideResolver,
  EMA_CROSSOVER_CONFIRMED_MIN_CONFIDENCE,
  EMA_CROSSOVER_CONFIRMED_MIN_FINAL,
} from './strategyModePolicy';

describe('strategyModePolicy overrides (Phase 2)', () => {
  afterEach(() => {
    clearStrategyModeOverrideResolver();
  });

  it('applies explicit override argument over registry default', () => {
    expect(resolveEffectiveStrategyMode('bullish_breakout', undefined, 'WATCHLIST_ONLY')).toBe(
      'WATCHLIST_ONLY',
    );
    expect(canStrategyProduceConfirmedSignal('bullish_breakout')).toBe(true);
  });

  it('applies runtime override resolver', () => {
    setStrategyModeOverrideResolver((id) =>
      id === 'bullish_breakout' ? 'DISABLED' : null,
    );
    expect(resolveEffectiveStrategyMode('bullish_breakout')).toBe('DISABLED');
    expect(canStrategyProduceConfirmedSignal('bullish_breakout')).toBe(false);
    expect(resolveEffectiveStrategyMode('momentum_continuation')).not.toBe('DISABLED');
  });

  it('admin WATCHLIST_ONLY override is not reopened by score-gating', () => {
    expect(resolveEffectiveStrategyMode('ema_crossover', {
      finalScore: EMA_CROSSOVER_CONFIRMED_MIN_FINAL,
      confidenceScore: EMA_CROSSOVER_CONFIRMED_MIN_CONFIDENCE,
    }, 'WATCHLIST_ONLY')).toBe('WATCHLIST_ONLY');
  });
});
