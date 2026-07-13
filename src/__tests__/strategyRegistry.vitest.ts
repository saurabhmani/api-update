import { describe, expect, it } from 'vitest';
import {
  getStrategyDefinition,
  listStrategyDefinitions,
  getStrategiesForAssetAndRegime,
} from '@/lib/platform/strategyRegistry';

describe('strategy registry', () => {
  it('hydrates from canonical STRATEGY_REGISTRY', () => {
    const def = getStrategyDefinition('bullish_breakout');
    expect(def).not.toBeNull();
    expect(def?.supportedAssets).toContain('equity');
    expect(def?.requiredFeatures).toContain('trend');
    expect(def?.version).toBe('1.0.0');
  });

  it('filters strategies by asset class', () => {
    const equity = listStrategyDefinitions({ assetClass: 'equity' });
    expect(equity.length).toBeGreaterThan(10);
    for (const d of equity) {
      expect(d.supportedAssets).toContain('equity');
    }
  });

  it('returns strategies for asset and regime', () => {
    const strategies = getStrategiesForAssetAndRegime('equity', 'Bullish');
    expect(strategies.some((s) => s.strategyId === 'bullish_breakout')).toBe(true);
  });
});
