import { describe, it, expect } from 'vitest';
import { buildCategoryIndex, categoryLabel, riskProfileLabel } from './categories';
import { loadAllStrategySummaries } from './registry';

describe('strategy-hub categories', () => {
  it('builds category index with counts', () => {
    const strategies = loadAllStrategySummaries();
    const counts: Partial<Record<string, number>> = {};
    for (const s of strategies) {
      counts[s.category] = (counts[s.category] ?? 0) + 1;
    }
    const index = buildCategoryIndex(counts);
    expect(index.length).toBeGreaterThan(0);
    expect(index[0].strategyCount).toBeGreaterThan(0);
    expect(index[0].label).toBeTruthy();
  });

  it('labels known categories', () => {
    expect(categoryLabel('breakout')).toBe('Breakout');
    expect(categoryLabel('trend_following')).toBe('Trend Following');
    expect(categoryLabel('pullback')).toBe('Pullback');
  });

  it('labels risk profiles', () => {
    expect(riskProfileLabel('moderate')).toBe('Moderate');
    expect(riskProfileLabel('moderate_high')).toBe('Moderate-High');
  });
});
