import { describe, it, expect } from 'vitest';
import {
  validateParamValue,
  validateConfigurationPatch,
  summarizeConfigChanges,
} from './strategyParameterCatalog';
import {
  mergeRegistryWithOverrides,
  getOverriddenKeys,
} from './effectiveStrategyConfig';

describe('strategyParameterCatalog', () => {
  it('validates RSI range bounds', () => {
    expect(validateParamValue('idealRsiRange', [20, 80]).ok).toBe(true);
    expect(validateParamValue('idealRsiRange', [80, 20]).ok).toBe(false);
    expect(validateParamValue('idealRsiRange', [-1, 50]).ok).toBe(false);
  });

  it('rejects negative ADX', () => {
    expect(validateParamValue('minAdx', 20).ok).toBe(true);
    expect(validateParamValue('minAdx', -1).ok).toBe(false);
  });

  it('validates confidence weight bounds', () => {
    expect(validateParamValue('defaultConfidenceWeight', 1.0).ok).toBe(true);
    expect(validateParamValue('defaultConfidenceWeight', 3).ok).toBe(false);
  });

  it('rejects overlapping allowed/blocked regimes', () => {
    const result = validateConfigurationPatch({
      allowedRegimes: ['Bullish', 'Sideways'],
      blockedRegimes: ['Bullish'],
    });
    expect(result.valid).toBe(false);
  });

  it('summarizes changes', () => {
    const summary = summarizeConfigChanges(
      { minAdx: 20 },
      { minAdx: 25 },
    );
    expect(summary).toContain('minAdx');
  });
});

describe('effectiveStrategyConfig', () => {
  it('merges overrides over registry defaults', () => {
    const merged = mergeRegistryWithOverrides('bullish_breakout', {
      minAdx: 30,
      defaultConfidenceWeight: 1.1,
    });
    expect(merged).not.toBeNull();
    expect(merged!.minAdx).toBe(30);
    expect(merged!.defaultConfidenceWeight).toBe(1.1);
    expect(merged!.idealRsiRange).toBeDefined();
  });

  it('tracks overridden keys', () => {
    expect(getOverriddenKeys({ minAdx: 22 })).toEqual(['minAdx']);
  });

  it('uses registry when no overrides', () => {
    const merged = mergeRegistryWithOverrides('bullish_breakout', null);
    expect(merged?.allowedRegimes.length).toBeGreaterThan(0);
  });
});
