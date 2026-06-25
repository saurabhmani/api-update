import { describe, it, expect } from 'vitest';
import { applyRegimeConfidenceModifier, getRegimeCategoryModifier } from './regimeConfidence';

describe('regimeConfidence', () => {
  it('boosts BUY confidence in bullish regime', () => {
    const result = applyRegimeConfidenceModifier(70, 'BUY', {
      category: 'bullish',
      label: 'Bullish Trend',
      allowBullishSignals: true,
    });
    expect(result.modifier).toBe(8);
    expect(result.adjustedConfidence).toBe(78);
  });

  it('penalizes BUY in bearish regime', () => {
    const result = applyRegimeConfidenceModifier(70, 'BUY', {
      category: 'bearish',
      label: 'Bearish Trend',
      allowBullishSignals: true,
    });
    expect(result.modifier).toBe(-6);
    expect(result.adjustedConfidence).toBe(64);
  });

  it('caps BUY confidence when bullish signals blocked', () => {
    const result = applyRegimeConfidenceModifier(80, 'BUY', {
      category: 'sideways',
      label: 'Range-bound',
      allowBullishSignals: false,
    });
    expect(result.modifier).toBeLessThanOrEqual(-8);
    expect(result.adjustedConfidence).toBeLessThanOrEqual(72);
  });

  it('returns category-level modifier for platform display', () => {
    expect(getRegimeCategoryModifier('high_volatility')).toBe(-12);
    expect(getRegimeCategoryModifier('bullish')).toBe(5);
  });
});
