/**
 * Provider selection after vendor decommission.
 * Default kite; MARKET_DATA_PROVIDER pin respected; no legacy vendor override.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getMarketDataProvider,
  getPrimaryFallbackProvider,
  isLegacyVendorPrimary,
  isKitePrimary,
  isKiteSupportedCapability,
  getProviderFlagsSummary,
} from '@/lib/marketData/providerFlags';

const ENV_KEYS = ['MARKET_DATA_PROVIDER'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('provider flags — kite default', () => {
  it('unset MARKET_DATA_PROVIDER → kite', () => {
    expect(getMarketDataProvider()).toBe('kite');
    expect(isKitePrimary()).toBe(true);
    expect(isLegacyVendorPrimary()).toBe(false);
    expect(getPrimaryFallbackProvider()).toBe('yahoo|nse|db');
  });

  it('MARKET_DATA_PROVIDER=yahoo selects yahoo', () => {
    process.env.MARKET_DATA_PROVIDER = 'yahoo';
    expect(getMarketDataProvider()).toBe('yahoo');
  });

  it('unrecognized MARKET_DATA_PROVIDER pin maps to kite', () => {
    process.env.MARKET_DATA_PROVIDER = 'not-a-provider';
    expect(getMarketDataProvider()).toBe('kite');
  });

  it('provider flags summary reports kite + yahoo|nse|db fallback', () => {
    const s = getProviderFlagsSummary();
    expect(s.marketDataProvider).toBe('kite');
    expect(s.kitePrimary).toBe(true);
    expect(s.primaryFallbackProvider).toBe('yahoo|nse|db');
  });

  it('Kite-supported capabilities', () => {
    expect(isKiteSupportedCapability('quotes')).toBe(true);
    expect(isKiteSupportedCapability('movers')).toBe(false);
    expect(isKiteSupportedCapability('news')).toBe(false);
  });
});
