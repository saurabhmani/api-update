/**
 * Phase 9 — Kite as default market-data provider.
 *
 * Verifies selection precedence without changing fallback behaviour:
 *   unset → kite
 *   MARKET_DATA_PROVIDER=indianapi → indianapi (existing installs)
 *   INDIANAPI_PRIMARY=true → indianapi (wins over everything)
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getMarketDataProvider,
  getPrimaryFallbackProvider,
  isIndianApiPrimary,
  isKitePrimary,
  isKiteSupportedCapability,
  getProviderFlagsSummary,
} from '@/lib/marketData/providerFlags';

const ENV_KEYS = [
  'MARKET_DATA_PROVIDER',
  'INDIANAPI_PRIMARY',
  'INDIANAPI_ENABLED',
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

describe('Phase 9 — fresh install defaults to Kite', () => {
  it('unset MARKET_DATA_PROVIDER + unset INDIANAPI_PRIMARY → kite', () => {
    expect(getMarketDataProvider()).toBe('kite');
    expect(isKitePrimary()).toBe(true);
    expect(isIndianApiPrimary()).toBe(false);
    expect(getPrimaryFallbackProvider()).toBe('indianapi');
  });

  it('empty MARKET_DATA_PROVIDER string still defaults to kite', () => {
    process.env.MARKET_DATA_PROVIDER = '   ';
    expect(getMarketDataProvider()).toBe('kite');
  });

  it('provider flags summary reports kite + indianapi fallback', () => {
    const s = getProviderFlagsSummary();
    expect(s.marketDataProvider).toBe('kite');
    expect(s.kitePrimary).toBe(true);
    expect(s.primaryFallbackProvider).toBe('indianapi');
  });
});

describe('Phase 9 — existing indianapi pin unchanged', () => {
  it('MARKET_DATA_PROVIDER=indianapi remains indianapi', () => {
    process.env.MARKET_DATA_PROVIDER = 'indianapi';
    expect(getMarketDataProvider()).toBe('indianapi');
    expect(isIndianApiPrimary()).toBe(true);
    expect(isKitePrimary()).toBe(false);
  });

  it('MARKET_DATA_PROVIDER=kite with INDIANAPI_PRIMARY=false selects kite', () => {
    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';
    expect(getMarketDataProvider()).toBe('kite');
  });
});

describe('Phase 9 — INDIANAPI_PRIMARY overrides everything', () => {
  it('INDIANAPI_PRIMARY=true wins over MARKET_DATA_PROVIDER=kite', () => {
    process.env.MARKET_DATA_PROVIDER = 'kite';
    process.env.INDIANAPI_PRIMARY = 'true';
    expect(getMarketDataProvider()).toBe('indianapi');
  });

  it('INDIANAPI_PRIMARY=1 wins over unset MARKET_DATA_PROVIDER', () => {
    process.env.INDIANAPI_PRIMARY = '1';
    expect(getMarketDataProvider()).toBe('indianapi');
  });
});

describe('Phase 9 — unsupported capabilities stay on IndianAPI', () => {
  it('quotes/historical/search are Kite-supported; movers/news/corporate are not', () => {
    expect(isKiteSupportedCapability('quotes')).toBe(true);
    expect(isKiteSupportedCapability('batch_quotes')).toBe(true);
    expect(isKiteSupportedCapability('historical')).toBe(true);
    expect(isKiteSupportedCapability('search')).toBe(true);
    expect(isKiteSupportedCapability('movers')).toBe(false);
    expect(isKiteSupportedCapability('trending')).toBe(false);
    expect(isKiteSupportedCapability('news')).toBe(false);
    expect(isKiteSupportedCapability('corporate')).toBe(false);
    expect(isKiteSupportedCapability('mutual_funds')).toBe(false);
    expect(isKiteSupportedCapability('forecasts')).toBe(false);
  });
});
