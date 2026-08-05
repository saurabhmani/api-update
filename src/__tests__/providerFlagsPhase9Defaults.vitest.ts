/**
 * IndianAPI-only provider flags — kite is never primary; kite env aliases to indianapi.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getMarketDataProvider,
  getSystemLiveFeedProvider,
  getPrimaryFallbackProvider,
  isLegacyVendorPrimary,
  isKitePrimary,
  isKiteSupportedCapability,
  isYahooEmergencyFallbackEnabled,
  isNseDirectFallbackEnabled,
  getProviderFlagsSummary,
  resetIndianApiRpsWarningsForTests,
} from '@/lib/marketData/providerFlags';

const ENV_KEYS = [
  'MARKET_DATA_PROVIDER',
  'YAHOO_EMERGENCY_FALLBACK_ENABLED',
  'NSE_DIRECT_FALLBACK_ENABLED',
  'KITE_ENABLED',
  'INDIANAPI_ENABLED',
  'INDIANAPI_API_KEY',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  resetIndianApiRpsWarningsForTests();
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

describe('provider flags — IndianAPI-only', () => {
  it('unset MARKET_DATA_PROVIDER → none (not kite)', () => {
    expect(getMarketDataProvider()).toBe('none');
    expect(isKitePrimary()).toBe(false);
    expect(isLegacyVendorPrimary()).toBe(false);
    expect(getPrimaryFallbackProvider()).toBe('none');
    expect(getSystemLiveFeedProvider()).toBe('none');
  });

  it('bootstrap defaults to indianapi when enabled + credentials', () => {
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'test-key';
    expect(getMarketDataProvider()).toBe('indianapi');
    expect(getPrimaryFallbackProvider()).toBe('cache|db');
    expect(getSystemLiveFeedProvider()).toBe('none');
    expect(isKitePrimary()).toBe(false);
  });

  it('MARKET_DATA_PROVIDER=yahoo selects yahoo', () => {
    process.env.MARKET_DATA_PROVIDER = 'yahoo';
    expect(getMarketDataProvider()).toBe('yahoo');
    expect(getSystemLiveFeedProvider()).toBe('yahoo');
  });

  it('MARKET_DATA_PROVIDER=kite resolves to none (never kite or indianapi alias)', () => {
    process.env.MARKET_DATA_PROVIDER = 'kite';
    expect(getMarketDataProvider()).toBe('none');
    expect(isKitePrimary()).toBe(false);
    expect(getSystemLiveFeedProvider()).toBe('none');
    expect(getPrimaryFallbackProvider()).toBe('none');
  });

  it('unrecognized MARKET_DATA_PROVIDER pin maps to none', () => {
    process.env.MARKET_DATA_PROVIDER = 'not-a-provider';
    expect(getMarketDataProvider()).toBe('none');
  });

  it('Yahoo and NSE emergency fallbacks default OFF', () => {
    expect(isYahooEmergencyFallbackEnabled()).toBe(false);
    expect(isNseDirectFallbackEnabled()).toBe(false);
  });

  it('provider flags summary reports indianapi-only shape', () => {
    const s = getProviderFlagsSummary();
    expect(s.marketDataProvider).toBe('none');
    expect(s.kitePrimary).toBe(false);
    expect(s.primaryFallbackProvider).toBe('none');
    expect(s.hiddenDefaultsRemoved).toBe(true);
    expect(s.brokersRemovedFromMarketData).toBe(true);
  });

  it('Kite-supported capabilities list retained for compat', () => {
    expect(isKiteSupportedCapability('quotes')).toBe(true);
    expect(isKiteSupportedCapability('movers')).toBe(false);
    expect(isKiteSupportedCapability('news')).toBe(false);
  });
});
