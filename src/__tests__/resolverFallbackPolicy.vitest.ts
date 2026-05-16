/**
 * Resolver fallback-policy contract tests (spec §1, §2, §3, §4, §5).
 *
 *   §1 MARKET_CHECK   — when market is closed the resolver must NOT
 *                       call IndianAPI / NSE direct / Yahoo. Returns a
 *                       cache hit, or `provider='snapshot'` +
 *                       `errorCode='MARKET_CLOSED'`.
 *
 *   §2 FAILURE_TYPES  — only TRUE failures (timeout / network / 5xx /
 *                       empty / invalid) cascade. 409, MARKET_CLOSED,
 *                       BUDGET_*, ROUTE_REMOVED do NOT cascade.
 *
 *   §3 FALLBACK_FLOW  — IndianAPI true-fail → NSE → Yahoo, but only
 *                       when market is open AND the failure is true.
 *
 *   §4 RESPONSE_FORMAT— `provider` + `fallbackUsed` populated on every
 *                       return path.
 *
 *   §5 LOGGING        — `RESOLVER_OUTCOME` emitted exactly once per
 *                       resolve call, with provider_used /
 *                       fallback_triggered / failure_reason fields.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getNseBatchLivePrice, fetchNseDirectQuotes, memCache, marketOpen } = vi.hoisted(() => ({
  getNseBatchLivePrice: vi.fn(),
  fetchNseDirectQuotes: vi.fn(),
  memCache: new Map<string, unknown>(),
  marketOpen: { value: true },
}));

vi.mock('@/lib/marketData/providers/indianApiProvider', () => ({
  getNseBatchLivePrice,
  getStockDetails: vi.fn(),
}));

vi.mock('@/lib/marketData/providers/nseDirectProvider', () => ({
  fetchNseDirectQuotes,
}));

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

vi.mock('@/lib/marketData/marketHours', async () => {
  const actual = await vi.importActual<any>('@/lib/marketData/marketHours');
  return {
    ...actual,
    isMarketOpen: () => marketOpen.value,
    getMarketStatus: () => ({
      isOpen: marketOpen.value,
      state: marketOpen.value ? 'open' : 'closed',
      label: marketOpen.value ? 'Market Open' : 'Market Closed',
      nowIst: '', sessionOpenIst: '', sessionCloseIst: '',
    }),
  };
});

import { resolveBatch } from '@/lib/marketData/resolver/marketDataResolver';
import { quoteCacheKey } from '@/lib/cache';

beforeEach(() => {
  process.env.INDIANAPI_PRIMARY = 'true';
  // Default: market open. Tests that need closed-state flip explicitly.
  marketOpen.value = true;
  memCache.clear();
  getNseBatchLivePrice.mockReset();
  fetchNseDirectQuotes.mockReset();
});

afterEach(() => { vi.useRealTimers(); });

function makeSnap(sym: string, price: number) {
  return {
    symbol: sym, price, ltp: price, change: 0, changePercent: 0,
    volume: 1, open: price, high: price, low: price, prevClose: price,
    timestamp: Date.now(),
  };
}

function failedInv(errorCode: string, errorMessage = 'mocked') {
  return {
    provider: 'indianapi' as const,
    endpoint: 'stock(emulated_batch)',
    requestStartedAt: new Date().toISOString(),
    responseReceivedAt: new Date().toISOString(),
    latencyMs: 50,
    status: 'failed' as const,
    dataQuality: 'LOW' as const,
    symbolsRequested: 1,
    symbolsReturned: 0,
    coveragePercent: 0,
    staleSymbols: [],
    failedSymbols: ['RELIANCE'],
    freshnessScore: 0,
    errorCode,
    errorMessage,
    data: null,
  };
}

describe('resolveBatch — spec §1 (market-closed gate)', () => {
  it('market closed: NO upstream call, returns provider=snapshot when cache empty', async () => {
    marketOpen.value = false;
    const r = await resolveBatch(['RELIANCE']);
    expect(getNseBatchLivePrice).not.toHaveBeenCalled();
    expect(fetchNseDirectQuotes).not.toHaveBeenCalled();
    expect(r.provider).toBe('snapshot');
    expect(r.errorCode).toBe('MARKET_CLOSED');
    expect(r.fallbackUsed).toBe(false);
  });

  it('market closed with warm cache: returns provider=cache, no upstream', async () => {
    marketOpen.value = false;
    memCache.set(quoteCacheKey('RELIANCE'), makeSnap('RELIANCE', 2500));
    const r = await resolveBatch(['RELIANCE']);
    expect(getNseBatchLivePrice).not.toHaveBeenCalled();
    expect(fetchNseDirectQuotes).not.toHaveBeenCalled();
    expect(r.provider).toBe('cache');
    expect(r.errorCode).toBe('MARKET_CLOSED');
    expect(r.symbolsReturned).toBe(1);
  });
});

describe('resolveBatch — NIFTY500 lock (§6, §9)', () => {
  it('rejects every non-NIFTY500 symbol and returns NIFTY500_LOCK_REJECTED_ALL', async () => {
    getNseBatchLivePrice.mockResolvedValue({
      provider: 'indianapi', status: 'success', dataQuality: 'HIGH',
      requestStartedAt: new Date().toISOString(), responseReceivedAt: new Date().toISOString(),
      latencyMs: 50, symbolsRequested: 0, symbolsReturned: 0, coveragePercent: 0,
      staleSymbols: [], failedSymbols: [], freshnessScore: 0,
      errorCode: null, errorMessage: null,
      data: { snapshots: [], missing: [] },
    });
    const r = await resolveBatch(['NOTASTOCK1', 'NOTASTOCK2']);
    expect(getNseBatchLivePrice).not.toHaveBeenCalled();
    expect(r.errorCode).toBe('NIFTY500_LOCK_REJECTED_ALL');
    expect(r.symbolsReturned).toBe(0);
  });

  it('keeps NIFTY500 symbols and drops non-members in mixed input', async () => {
    getNseBatchLivePrice.mockResolvedValue({
      provider: 'indianapi', status: 'success', dataQuality: 'HIGH',
      requestStartedAt: new Date().toISOString(), responseReceivedAt: new Date().toISOString(),
      latencyMs: 50, symbolsRequested: 1, symbolsReturned: 1, coveragePercent: 100,
      staleSymbols: [], failedSymbols: [], freshnessScore: 90,
      errorCode: null, errorMessage: null,
      data: { snapshots: [makeSnap('RELIANCE', 2500)], missing: [] },
    });
    const r = await resolveBatch(['RELIANCE', 'NOTASTOCK_XYZ']);
    // Only RELIANCE makes it past the lock; only one symbol gets sent upstream.
    expect(getNseBatchLivePrice).toHaveBeenCalledTimes(1);
    expect(getNseBatchLivePrice.mock.calls[0][0]).toEqual(['RELIANCE']);
    expect(r.symbolsRequested).toBe(1);
    expect(r.symbolsReturned).toBe(1);
  });
});

describe('resolveBatch — spec §2 (failure classification)', () => {
  it('IndianAPI returns 409: cascade is suppressed (no NSE direct call)', async () => {
    getNseBatchLivePrice.mockResolvedValue(failedInv('HTTP_409', 'conflict'));
    const r = await resolveBatch(['RELIANCE']);
    expect(getNseBatchLivePrice).toHaveBeenCalledTimes(1);
    expect(fetchNseDirectQuotes).not.toHaveBeenCalled();
    expect(r.errorCode).toBe('HTTP_409');
    expect(r.fallbackUsed).toBe(false);
  });

  it('IndianAPI returns MARKET_CLOSED (engine block): cascade suppressed', async () => {
    getNseBatchLivePrice.mockResolvedValue(failedInv('MARKET_CLOSED', 'engine block'));
    const r = await resolveBatch(['RELIANCE']);
    expect(fetchNseDirectQuotes).not.toHaveBeenCalled();
    expect(r.errorCode).toBe('MARKET_CLOSED');
    expect(r.fallbackUsed).toBe(false);
  });

  it('IndianAPI returns BUDGET_THROTTLED: cascade suppressed', async () => {
    getNseBatchLivePrice.mockResolvedValue(failedInv('BUDGET_THROTTLED', 'budget'));
    const r = await resolveBatch(['RELIANCE']);
    expect(fetchNseDirectQuotes).not.toHaveBeenCalled();
    expect(r.errorCode).toBe('BUDGET_THROTTLED');
    expect(r.fallbackUsed).toBe(false);
  });

  it('IndianAPI returns ROUTE_REMOVED: cascade suppressed', async () => {
    getNseBatchLivePrice.mockResolvedValue(failedInv('ROUTE_REMOVED', 'gone'));
    const r = await resolveBatch(['RELIANCE']);
    expect(fetchNseDirectQuotes).not.toHaveBeenCalled();
    expect(r.errorCode).toBe('ROUTE_REMOVED');
    expect(r.fallbackUsed).toBe(false);
  });
});
