import { describe, it, expect } from 'vitest';
import {
  getSignalEngineRegistry,
  isRegistryDrivenStrategy,
  FEATURED_STRATEGY_IDS,
} from './strategyRegistryService';

describe('strategyRegistryService', () => {
  it('exposes signal-engine registry as source of truth', () => {
    const registry = getSignalEngineRegistry();
    expect(Object.keys(registry).length).toBeGreaterThanOrEqual(20);
    expect(isRegistryDrivenStrategy('bullish_breakout')).toBe(true);
    expect(isRegistryDrivenStrategy('unknown_strategy')).toBe(false);
  });

  it('has at least 5 featured strategies for hub visibility', () => {
    const registry = getSignalEngineRegistry();
    expect(FEATURED_STRATEGY_IDS.length).toBeGreaterThanOrEqual(5);
    for (const id of FEATURED_STRATEGY_IDS) {
      expect(registry[id as keyof typeof registry]).toBeDefined();
    }
  });
});
