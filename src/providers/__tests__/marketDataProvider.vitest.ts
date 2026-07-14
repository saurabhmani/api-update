// ════════════════════════════════════════════════════════════════
//  MarketDataProvider — kite-primary fallback chain tests
// ════════════════════════════════════════════════════════════════

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/providers/adapters/KiteAdapter', () => ({
  getQuote: vi.fn(),
  getHistorical: vi.fn(),
  searchSymbol: vi.fn(),
  getMovers: vi.fn(),
  getCorporateIntel: vi.fn(),
  getFundamentals: vi.fn(),
  getBatchQuotes: vi.fn(),
}));
vi.mock('@/providers/adapters/YahooAdapter', () => ({
  getQuote: vi.fn(),
  getHistorical: vi.fn(),
  searchSymbol: vi.fn(),
  getMovers: vi.fn(),
  getCorporateIntel: vi.fn(),
  getIndustryPeers: vi.fn(),
}));

import MarketDataProvider, { registerDbRepo } from '@/providers/MarketDataProvider';
import * as Kite from '@/providers/adapters/KiteAdapter';
import * as Yahoo from '@/providers/adapters/YahooAdapter';
import { cache } from '@/lib/cache';
import { StaleDataError, type MarketSnapshot } from '@/types/market';
import { breaker } from '@/providers/resilience';

function makeSnap(symbol: string, price: number): MarketSnapshot {
  return {
    symbol, price, ltp: price,
    change: 0, changePercent: 0, volume: 100,
    open: price, high: price, low: price, prevClose: price,
    timestamp: Date.now(),
  };
}

function resetBreakerFor(...providers: string[]): void {
  for (const p of providers) {
    void breaker.exec(p, async () => undefined).catch(() => undefined);
  }
}

describe('MarketDataProvider', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env.LEGACY_VENDOR_ENV;
    process.env.MARKET_DATA_PROVIDER = 'kite';
    for (const sym of ['RELIANCE', 'TCS', 'INFY', 'X']) {
      await cache.del(`quote:${sym}`);
    }
    registerDbRepo({});
    resetBreakerFor('yahoo', 'kite');
  });

  it('returns kite snapshot as primary', async () => {
    vi.mocked(Kite.getQuote).mockResolvedValue(makeSnap('RELIANCE', 2500));
    const resp = await MarketDataProvider.getLiveSnapshot('RELIANCE');
    expect(resp.source).toBe('kite');
    expect(resp.data.price).toBe(2500);
    expect(resp.provider_name).toBe('Kite Connect');
  });

  it('falls back to yahoo when kite fails', async () => {
    process.env.YAHOO_EMERGENCY_FALLBACK_ENABLED = 'true';
    vi.mocked(Kite.getQuote).mockRejectedValue(new Error('kite down'));
    vi.mocked(Yahoo.getQuote).mockResolvedValue(makeSnap('RELIANCE', 2490));
    const resp = await MarketDataProvider.getLiveSnapshot('RELIANCE');
    expect(resp.source).toBe('yahoo');
    expect(resp.fallback_reason).toContain('kite');
  });

  it('retries kite on subsequent calls when primary (cache is post-miss only)', async () => {
    vi.mocked(Kite.getQuote).mockResolvedValue(makeSnap('TCS', 3500));
    const first = await MarketDataProvider.getLiveSnapshot('TCS');
    expect(first.source).toBe('kite');
    const second = await MarketDataProvider.getLiveSnapshot('TCS');
    expect(second.source).toBe('kite');
    expect(Kite.getQuote).toHaveBeenCalled();
  });

  it('rejects stale DB for signal-critical callers', async () => {
    vi.mocked(Kite.getQuote).mockRejectedValue(new Error('kite'));
    process.env.YAHOO_EMERGENCY_FALLBACK_ENABLED = 'false';
    registerDbRepo({
      getQuote: async () => makeSnap('INFY', 1400),
    });
    await expect(
      MarketDataProvider.getLiveSnapshot('INFY', { signalCritical: true }),
    ).rejects.toBeInstanceOf(StaleDataError);
  });
});
