/**
 * Resolver cache-first contract test.
 *
 *   Given a 2-symbol batch where ONE symbol is already cache-warm and
 *   ONE is cold, the resolver must call the IndianAPI batch endpoint
 *   exactly ONCE, with ONLY the cold symbol. The cache-warm symbol
 *   must come back in the result tagged source='cache'.
 *
 * This protects the budget: every cache hit avoided is a saved call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the IndianAPI provider wrapper before importing the resolver,
// so the resolver picks up our spy. vi.mock is hoisted to top of file,
// so we use vi.hoisted to keep the spy reference accessible to tests.
const { getNseBatchLivePrice, memCache } = vi.hoisted(() => ({
  getNseBatchLivePrice: vi.fn(),
  memCache: new Map<string, unknown>(),
}));

vi.mock('@/lib/marketData/providers/indianApiProvider', () => ({
  getNseBatchLivePrice,
  getStockDetails: vi.fn(),
}));

vi.mock('@/lib/marketData/providers/nseDirectProvider', () => ({
  fetchNseDirectQuotes: vi.fn(),
}));

// The resolver now has a hard market-closed gate (spec §1) that
// suppresses every upstream call when NSE is closed. Tests below
// assert IndianAPI WAS called for the cold misses, so we force the
// gate open by mocking `isMarketOpen=true` regardless of the wall clock.
vi.mock('@/lib/marketData/marketHours', async () => {
  const actual = await vi.importActual<any>('@/lib/marketData/marketHours');
  return {
    ...actual,
    isMarketOpen: () => true,
    getMarketStatus: () => ({
      isOpen: true, state: 'open', label: 'Market Open',
      nowIst: '', sessionOpenIst: '', sessionCloseIst: '',
    }),
  };
});

vi.mock('@/lib/cache', async () => {
  const actual = await vi.importActual<any>('@/lib/cache');
  return {
    ...actual,
    cache: {
      get: vi.fn(async (key: string) => memCache.get(key) ?? null),
      set: vi.fn(async (key: string, val: unknown) => { memCache.set(key, val); }),
    },
  };
});

import { resolveBatch } from '@/lib/marketData/resolver/marketDataResolver';
import { quoteCacheKey } from '@/lib/cache';

beforeEach(() => {
  memCache.clear();
  getNseBatchLivePrice.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function makeSnap(sym: string, price: number) {
  return {
    symbol: sym, price, ltp: price, change: 0, changePercent: 0,
    volume: 1, open: price, high: price, low: price, prevClose: price,
    timestamp: Date.now(),
  };
}

describe('resolveBatch — cache-first behaviour (Step 5)', () => {
  it('100% cache hit: zero IndianAPI calls', async () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    memCache.set(quoteCacheKey('RELIANCE'), makeSnap('RELIANCE', 2500));
    memCache.set(quoteCacheKey('TCS'),      makeSnap('TCS', 4000));

    const r = await resolveBatch(['RELIANCE', 'TCS']);

    expect(getNseBatchLivePrice).not.toHaveBeenCalled();
    expect(r.provider).toBe('cache');
    expect(r.status).toBe('success');
    expect(r.symbolsReturned).toBe(2);
    expect(r.coveragePercent).toBe(100);
  });

  it('partial cache hit: one IndianAPI call for ONLY the misses', async () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    memCache.set(quoteCacheKey('RELIANCE'), makeSnap('RELIANCE', 2500));
    // INFY is cold — must trigger ONE call with [INFY] only.
    getNseBatchLivePrice.mockResolvedValue({
      provider: 'indianapi',
      status: 'success',
      dataQuality: 'HIGH',
      requestStartedAt: new Date().toISOString(),
      responseReceivedAt: new Date().toISOString(),
      latencyMs: 100,
      symbolsRequested: 1,
      symbolsReturned: 1,
      coveragePercent: 100,
      staleSymbols: [],
      failedSymbols: [],
      freshnessScore: 90,
      errorCode: null,
      errorMessage: null,
      data: { snapshots: [makeSnap('INFY', 1700)], missing: [] },
    });

    const r = await resolveBatch(['RELIANCE', 'INFY']);

    expect(getNseBatchLivePrice).toHaveBeenCalledTimes(1);
    const arg = getNseBatchLivePrice.mock.calls[0][0];
    expect(arg).toEqual(['INFY']);
    expect(r.provider).toBe('indianapi');
    expect(r.symbolsReturned).toBe(2);
    // Per-row source: RELIANCE from cache, INFY from indianapi.
    expect(r.data['NSE:RELIANCE']?.source).toBe('cache');
    expect(r.data['NSE:INFY']?.source).toBe('indianapi');
  });

  it('forceRefresh skips the cache-first path entirely', async () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    memCache.set(quoteCacheKey('RELIANCE'), makeSnap('RELIANCE', 2500));
    getNseBatchLivePrice.mockResolvedValue({
      provider: 'indianapi',
      status: 'success',
      dataQuality: 'HIGH',
      requestStartedAt: new Date().toISOString(),
      responseReceivedAt: new Date().toISOString(),
      latencyMs: 100,
      symbolsRequested: 1,
      symbolsReturned: 1,
      coveragePercent: 100,
      staleSymbols: [],
      failedSymbols: [],
      freshnessScore: 90,
      errorCode: null,
      errorMessage: null,
      data: { snapshots: [makeSnap('RELIANCE', 2510)], missing: [] },
    });

    const r = await resolveBatch(['RELIANCE'], { forceRefresh: true });

    expect(getNseBatchLivePrice).toHaveBeenCalledTimes(1);
    const arg = getNseBatchLivePrice.mock.calls[0][0];
    expect(arg).toEqual(['RELIANCE']);
    expect(r.provider).toBe('indianapi');
  });
});
