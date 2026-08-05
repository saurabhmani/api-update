/**
 * Phase 5 provider selection — IndianAPI-only (broker primaries removed).
 */
import { beforeEach, describe, expect, it } from 'vitest';

describe('resolver Phase 5 — IndianAPI primary', () => {
  beforeEach(() => {
    delete process.env.LEGACY_VENDOR_ENV;
    delete process.env.MARKET_DATA_PROVIDER;
    delete process.env.INDIANAPI_ENABLED;
    delete process.env.INDIANAPI_API_KEY;
  });

  it('MARKET_DATA_PROVIDER=kite resolves to none (unsupported)', async () => {
    process.env.MARKET_DATA_PROVIDER = 'kite';
    const { getMarketDataProvider } = await import('@/lib/marketData/providerFlags');
    expect(getMarketDataProvider()).toBe('none');
  });

  it('MARKET_DATA_PROVIDER=indianapi selects indianapi', async () => {
    process.env.MARKET_DATA_PROVIDER = 'indianapi';
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'k';
    const { getMarketDataProvider, isIndianApiPrimary } = await import(
      '@/lib/marketData/providerFlags'
    );
    expect(getMarketDataProvider()).toBe('indianapi');
    expect(isIndianApiPrimary()).toBe(true);
  });
});
