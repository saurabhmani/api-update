/**
 * Retired broker OAuth / connectionManager tests replaced with IndianAPI-only guards.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('no broker SDK at runtime', () => {
  it('package.json does not list kiteconnect', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    expect(pkg.dependencies?.kiteconnect).toBeUndefined();
    expect(pkg.devDependencies?.kiteconnect).toBeUndefined();
  });

  it('MARKET_DATA_PROVIDER=kite resolves to none (unsupported)', async () => {
    const prev = process.env.MARKET_DATA_PROVIDER;
    process.env.MARKET_DATA_PROVIDER = 'kite';
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'test-key';
    try {
      const { resetIndianApiRpsWarningsForTests, getSystemMarketDataProvider } = await import(
        '@/lib/marketData/providerFlags'
      );
      resetIndianApiRpsWarningsForTests();
      expect(getSystemMarketDataProvider()).toBe('none');
    } finally {
      if (prev === undefined) delete process.env.MARKET_DATA_PROVIDER;
      else process.env.MARKET_DATA_PROVIDER = prev;
    }
  });

  it('MARKET_DATA_PROVIDER=indianapi resolves when enabled+keyed', async () => {
    const prev = process.env.MARKET_DATA_PROVIDER;
    process.env.MARKET_DATA_PROVIDER = 'indianapi';
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.INDIANAPI_API_KEY = 'test-key';
    try {
      const { getSystemMarketDataProvider } = await import('@/lib/marketData/providerFlags');
      expect(getSystemMarketDataProvider()).toBe('indianapi');
    } finally {
      if (prev === undefined) delete process.env.MARKET_DATA_PROVIDER;
      else process.env.MARKET_DATA_PROVIDER = prev;
    }
  });

  it('retired kite OAuth routes are absent (404)', async () => {
    expect(() => require.resolve('@/app/api/kite/auth/start/route')).toThrow();
  });

  it('getBrokerMarketDataProvider throws unsupported', async () => {
    const { getBrokerMarketDataProvider } = await import('@/lib/marketData/brokerProvider');
    expect(() => getBrokerMarketDataProvider('zerodha')).toThrow(/removed/i);
  });
});
