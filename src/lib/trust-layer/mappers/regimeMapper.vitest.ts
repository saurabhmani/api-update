import { describe, it, expect } from 'vitest';
import { mapRegimeToCategory, categoryDisplayLabel } from '@/lib/trust-layer/mappers/regimeMapper';

describe('regimeMapper', () => {
  it('maps bullish regimes', () => {
    expect(mapRegimeToCategory('Bullish')).toBe('bullish');
    expect(mapRegimeToCategory('Strong Bullish')).toBe('bullish');
  });

  it('maps bearish regimes', () => {
    expect(mapRegimeToCategory('Bearish')).toBe('bearish');
    expect(mapRegimeToCategory('Weak')).toBe('bearish');
  });

  it('maps sideways', () => {
    expect(mapRegimeToCategory('Sideways')).toBe('sideways');
  });

  it('maps high volatility', () => {
    expect(mapRegimeToCategory('High Volatility Risk')).toBe('high_volatility');
  });

  it('displays category labels', () => {
    expect(categoryDisplayLabel('bullish')).toBe('Bullish');
    expect(categoryDisplayLabel('high_volatility')).toBe('High Volatility');
  });
});
