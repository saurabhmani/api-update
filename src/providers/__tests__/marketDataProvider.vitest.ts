// MarketDataProvider — IndianAPI warehouse serve path (cache → DB)

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/providers/adapters/YahooAdapter', () => ({
  getQuote: vi.fn(),
  getHistorical: vi.fn(),
  searchSymbol: vi.fn(),
  getMovers: vi.fn(),
  getCorporateIntel: vi.fn(),
  getIndustryPeers: vi.fn(),
}));

import MarketDataProvider, { registerDbRepo } from '@/providers/MarketDataProvider';
import * as Yahoo from '@/providers/adapters/YahooAdapter';
import { cache } from '@/lib/cache';
import { StaleDataError, type MarketSnapshot } from '@/types/market';

function makeSnap(symbol: string, price: number): MarketSnapshot {
  return {
    symbol, price, ltp: price,
    change: 0, changePercent: 0, volume: 100,
    open: price, high: price, low: price, prevClose: price,
    timestamp: Date.now(),
  };
}

describe('MarketDataProvider — IndianAPI warehouse', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    process.env.MARKET_DATA_PROVIDER = 'indianapi';
    process.env.INDIANAPI_ENABLED = 'true';
    process.env.YAHOO_EMERGENCY_FALLBACK_ENABLED = 'false';
    for (const sym of ['RELIANCE', 'TCS', 'INFY']) {
      await cache.del(`quote:${sym}`);
    }
    registerDbRepo({});
  });

  it('serves cache without calling Yahoo', async () => {
    await cache.set('quote:RELIANCE', makeSnap('RELIANCE', 2500), 60);
    const resp = await MarketDataProvider.getLiveSnapshot('RELIANCE');
    expect(resp.source).toBe('cache');
    expect(Yahoo.getQuote).not.toHaveBeenCalled();
  });

  it('rejects empty warehouse for signal-critical callers', async () => {
    await expect(
      MarketDataProvider.getLiveSnapshot('INFY', { signalCritical: true }),
    ).rejects.toBeInstanceOf(StaleDataError);
  });
});
