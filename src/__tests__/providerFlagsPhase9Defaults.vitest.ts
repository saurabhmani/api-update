/**
 * Phase 11 — no hidden MARKET_DATA_PROVIDER / Yahoo / NSE defaults.
 * System provider unset → none; emergency fallbacks default OFF.
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
} from '@/lib/marketData/providerFlags';

const ENV_KEYS = [
  'MARKET_DATA_PROVIDER',
  'YAHOO_EMERGENCY_FALLBACK_ENABLED',
  'NSE_DIRECT_FALLBACK_ENABLED',
  'KITE_ENABLED',
] as const;
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

describe('provider flags — Phase 11 no hidden defaults', () => {
  it('unset MARKET_DATA_PROVIDER → none (not kite)', () => {
    expect(getMarketDataProvider()).toBe('none');
    expect(isKitePrimary()).toBe(false);
    expect(isLegacyVendorPrimary()).toBe(false);
    expect(getPrimaryFallbackProvider()).toBe('none');
    expect(getSystemLiveFeedProvider()).toBe('none');
  });

  it('MARKET_DATA_PROVIDER=yahoo selects yahoo', () => {
    process.env.MARKET_DATA_PROVIDER = 'yahoo';
    expect(getMarketDataProvider()).toBe('yahoo');
    expect(getSystemLiveFeedProvider()).toBe('yahoo');
  });

  it('MARKET_DATA_PROVIDER=kite selects kite live feed', () => {
    process.env.MARKET_DATA_PROVIDER = 'kite';
    expect(getMarketDataProvider()).toBe('kite');
    expect(isKitePrimary()).toBe(true);
    expect(getSystemLiveFeedProvider()).toBe('kite');
    expect(getPrimaryFallbackProvider()).toBe('yahoo|nse|db');
  });

  it('unrecognized MARKET_DATA_PROVIDER pin maps to none', () => {
    process.env.MARKET_DATA_PROVIDER = 'not-a-provider';
    expect(getMarketDataProvider()).toBe('none');
  });

  it('Yahoo and NSE emergency fallbacks default OFF', () => {
    expect(isYahooEmergencyFallbackEnabled()).toBe(false);
    expect(isNseDirectFallbackEnabled()).toBe(false);
  });

  it('provider flags summary reports none when unset', () => {
    const s = getProviderFlagsSummary();
    expect(s.marketDataProvider).toBe('none');
    expect(s.kitePrimary).toBe(false);
    expect(s.primaryFallbackProvider).toBe('none');
    expect(s.hiddenDefaultsRemoved).toBe(true);
  });

  it('Kite-supported capabilities', () => {
    expect(isKiteSupportedCapability('quotes')).toBe(true);
    expect(isKiteSupportedCapability('movers')).toBe(false);
    expect(isKiteSupportedCapability('news')).toBe(false);
  });
});
