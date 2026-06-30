import { describe, it, expect } from 'vitest';
import {
  FEATURED_STRATEGY_IDS,
  loadAllStrategySummaries,
  loadStrategyDetail,
  getRegistryEntry,
} from './registry';

describe('strategy-hub registry', () => {
  it('loads all strategies from signal-engine registry', () => {
    const all = loadAllStrategySummaries();
    expect(all.length).toBeGreaterThanOrEqual(20);
  });

  it('includes all 5 featured initial strategies', () => {
    const ids = FEATURED_STRATEGY_IDS;
    expect(ids).toContain('bullish_breakout');
    expect(ids).toContain('momentum_continuation');
    expect(ids).toContain('bullish_pullback');
    expect(ids).toContain('fibonacci_pullback');
    expect(ids).toContain('ema_crossover');
    for (const id of ids) {
      expect(getRegistryEntry(id)).not.toBeNull();
    }
  });

  it('maps bullish_breakout with full metadata', () => {
    const detail = loadStrategyDetail('bullish_breakout');
    expect(detail).not.toBeNull();
    expect(detail!.displayName).toBe('Bullish Breakout');
    expect(detail!.category).toBe('breakout');
    expect(detail!.riskProfile).toBe('moderate');
    expect(detail!.strategyMode).toBe('CONFIRMED_ENABLED');
    expect(detail!.isFeatured).toBe(true);
    expect(detail!.isActiveInRunner).toBe(true);
    expect(detail!.hasEvaluator).toBe(true);
  });

  it('exposes WATCHLIST_ONLY mode for mean reversion strategies', () => {
    const detail = loadStrategyDetail('mean_reversion_bounce');
    expect(detail?.strategyMode).toBe('WATCHLIST_ONLY');
  });

  it('sorts featured strategies first', () => {
    const all = loadAllStrategySummaries();
    const firstFeatured = all.findIndex((s) => s.isFeatured);
    const firstNonFeatured = all.findIndex((s) => !s.isFeatured);
    if (firstFeatured >= 0 && firstNonFeatured >= 0) {
      expect(firstFeatured).toBeLessThan(firstNonFeatured);
    }
  });
});
