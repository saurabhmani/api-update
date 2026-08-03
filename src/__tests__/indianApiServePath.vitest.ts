// ════════════════════════════════════════════════════════════════
//  IndianAPI serve path — MarketDataProvider in indianapi mode.
//
//  The invariant under test: with MARKET_DATA_PROVIDER=indianapi the
//  request path serves CACHE → DB ONLY. It must never touch Kite or
//  Yahoo, and an empty warehouse is a loud StaleDataError — never a
//  silent provider switch.
// ════════════════════════════════════════════════════════════════

import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import type { HistoricalSeries, MarketSnapshot } from '@/types/market';
import { StaleDataError } from '@/types/market';

// The upstream adapters are mocked as hard failures — any invocation
// in indianapi mode is itself the bug. Handles are hoisted (instead of
// importing the adapter modules) so this test file honors the
// architecture-freeze ban on direct adapter imports.
const upstream = vi.hoisted(() => {
  const forbid = (name: string) =>
    vi.fn(async () => { throw new Error(`${name} must not be called in indianapi mode`); });
  return {
    kiteGetQuote: forbid('Kite.getQuote'),
    kiteGetBatchQuotes: forbid('Kite.getBatchQuotes'),
    kiteGetHistorical: forbid('Kite.getHistorical'),
    kiteSearchSymbol: forbid('Kite.searchSymbol'),
    yahooGetQuote: forbid('Yahoo.getQuote'),
    yahooGetHistorical: forbid('Yahoo.getHistorical'),
    yahooGetMovers: forbid('Yahoo.getMovers'),
    yahooSearchSymbol: forbid('Yahoo.searchSymbol'),
  };
});

vi.mock('@/providers/adapters/KiteAdapter', () => ({
  getQuote: upstream.kiteGetQuote,
  getBatchQuotes: upstream.kiteGetBatchQuotes,
  getHistorical: upstream.kiteGetHistorical,
  searchSymbol: upstream.kiteSearchSymbol,
}));

vi.mock('@/providers/adapters/YahooAdapter', () => ({
  getQuote: upstream.yahooGetQuote,
  getHistorical: upstream.yahooGetHistorical,
  getMovers: upstream.yahooGetMovers,
  searchSymbol: upstream.yahooSearchSymbol,
}));

vi.mock('@/lib/marketData/yahooFundamentals', () => ({
  fetchYahooFundamentals: vi.fn(async () => { throw new Error('Yahoo must not be called in indianapi mode'); }),
}));

vi.mock('@/lib/marketData/tickPropagator', () => ({
  propagateTick: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: { query: vi.fn(async () => ({ rows: [] })) },
}));

import * as MDP from '@/providers/MarketDataProvider';
import { registerDbRepo } from '@/providers/MarketDataProvider';
import { cacheSet } from '@/lib/redis';
import { quoteCacheKey } from '@/lib/cache';

const ENV_KEYS = ['MARKET_DATA_PROVIDER', 'REDIS_DISABLED', 'INDIANAPI_ENABLED', 'INDIANAPI_API_KEY'] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function snap(symbol: string, price = 100): MarketSnapshot {
  return {
    symbol, price, ltp: price, change: 1, changePercent: 1,
    volume: 1000, open: price, high: price, low: price,
    prevClose: price - 1, timestamp: Date.now(),
  };
}

beforeEach(() => {
  process.env.MARKET_DATA_PROVIDER = 'indianapi';
  process.env.REDIS_DISABLED = '1';
  registerDbRepo({});
  upstream.kiteGetQuote.mockClear();
  upstream.kiteGetBatchQuotes.mockClear();
  upstream.kiteGetHistorical.mockClear();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('getLiveSnapshot — indianapi mode', () => {
  it('serves an ingested quote from cache without any upstream call', async () => {
    await cacheSet(quoteCacheKey('SRVCACHE'), snap('SRVCACHE', 250), 60);
    const resp = await MDP.getLiveSnapshot('SRVCACHE');
    expect(resp.source).toBe('cache');
    expect(resp.data_quality).toBe('cached-fresh');
    expect(resp.data.price).toBe(250);
    expect(upstream.kiteGetQuote).not.toHaveBeenCalled();
  });

  it('falls back to the DB repo and tags the response stale', async () => {
    registerDbRepo({ getQuote: async sym => snap(sym, 99) });
    const resp = await MDP.getLiveSnapshot('SRVDB');
    expect(resp.source).toBe('db');
    expect(resp.data_quality).toBe('stale');
    expect(resp.data.price).toBe(99);
    expect(upstream.kiteGetQuote).not.toHaveBeenCalled();
  });

  it('throws StaleDataError when cache and DB are both empty — no silent fallback', async () => {
    await expect(MDP.getLiveSnapshot('SRVEMPTY')).rejects.toBeInstanceOf(StaleDataError);
    expect(upstream.kiteGetQuote).not.toHaveBeenCalled();
  });

  it('signal-critical callers reject db-stale data', async () => {
    registerDbRepo({ getQuote: async sym => snap(sym) });
    await expect(
      MDP.getLiveSnapshot('SRVSIG', { signalCritical: true }),
    ).rejects.toBeInstanceOf(StaleDataError);
  });
});

describe('getBatchLiveSnapshots — indianapi mode', () => {
  it('returns cached entries and stale placeholders with zero upstream calls', async () => {
    await cacheSet(quoteCacheKey('SRVB1'), snap('SRVB1'), 60);
    const result = await MDP.getBatchLiveSnapshots(['SRVB1', 'SRVB2']);
    expect(result.batchCallsMade).toBe(0);
    expect(result.missingAfterBatch).toEqual(['SRVB2']);
    const hit = result.entries.find(e => e.symbol === 'SRVB1');
    expect(hit?.source).toBe('cache');
    const miss = result.entries.find(e => e.symbol === 'SRVB2');
    expect(miss?.snapshot).toBeNull();
    expect(miss?.data_quality).toBe('stale');
    expect(upstream.kiteGetBatchQuotes).not.toHaveBeenCalled();
  });
});

describe('getHistorical — indianapi mode', () => {
  it('serves warehouse candles via the DB repo and never calls Kite', async () => {
    const series: HistoricalSeries = {
      symbol: 'SRVH', range: '1y',
      candles: [{ t: Date.now(), o: 1, h: 2, l: 1, c: 2, v: 100 }],
    };
    registerDbRepo({ getHistorical: async () => series });
    const resp = await MDP.getHistorical('SRVH', '1y');
    expect(resp.source).toBe('db');
    expect(resp.data.candles).toHaveLength(1);
    expect(upstream.kiteGetHistorical).not.toHaveBeenCalled();
  });

  it('throws StaleDataError when the warehouse has no series', async () => {
    await expect(MDP.getHistorical('SRVHEMPTY', '1y')).rejects.toBeInstanceOf(StaleDataError);
    expect(upstream.kiteGetHistorical).not.toHaveBeenCalled();
  });
});
