import { describe, it, expect } from 'vitest';
import {
  strategyModeLabel,
  strategyModeTone,
  MANAGEABLE_STRATEGY_MODES,
} from './strategyModeDisplay';
import { resolveBulkStrategyIds } from './services/modeManagementService';
import {
  extractModeOverride,
  isValidStrategyMode,
} from './services/strategyModeOverrides';

describe('strategyModeDisplay', () => {
  it('labels manageable modes', () => {
    expect(strategyModeLabel('CONFIRMED_ENABLED')).toBe('Enabled');
    expect(strategyModeLabel('WATCHLIST_ONLY')).toBe('Watchlist');
    expect(strategyModeLabel('DISABLED')).toBe('Disabled');
    expect(MANAGEABLE_STRATEGY_MODES).toContain('CONFIRMED_ENABLED');
  });

  it('assigns badge tones', () => {
    expect(strategyModeTone('CONFIRMED_ENABLED')).toBe('green');
    expect(strategyModeTone('WATCHLIST_ONLY')).toBe('orange');
    expect(strategyModeTone('DISABLED')).toBe('red');
  });
});

describe('strategyModeOverrides helpers', () => {
  it('validates modes', () => {
    expect(isValidStrategyMode('CONFIRMED_ENABLED')).toBe(true);
    expect(isValidStrategyMode('bogus')).toBe(false);
  });

  it('extracts overrides from metadata', () => {
    expect(extractModeOverride({ strategyModeOverride: 'DISABLED' })).toBe('DISABLED');
    expect(extractModeOverride({ strategyModeOverride: 'nope' })).toBeNull();
    expect(extractModeOverride(null)).toBeNull();
  });
});

describe('resolveBulkStrategyIds', () => {
  it('returns explicit strategy ids', () => {
    expect(resolveBulkStrategyIds({ strategyIds: ['bullish_breakout', 'ema_crossover'] })).toEqual([
      'bullish_breakout',
      'ema_crossover',
    ]);
  });

  it('filters by category', () => {
    const ids = resolveBulkStrategyIds({ category: 'confirmation' });
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toContain('multi_timeframe_alignment');
  });

  it('filters by strategy type entry vs confirmation', () => {
    const confirmation = resolveBulkStrategyIds({ strategyType: 'confirmation' });
    const entry = resolveBulkStrategyIds({ strategyType: 'entry' });
    expect(confirmation).toContain('multi_timeframe_alignment');
    expect(entry).not.toContain('multi_timeframe_alignment');
    expect(entry.length).toBeGreaterThan(0);
  });
});
