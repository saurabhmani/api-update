/**
 * Phase 5 — marketDataResolver provider-selection parity with MarketDataProvider.
 *
 * Covers:
 *   • IndianAPI default (Kite never called)
 *   • Kite selected primary
 *   • Kite auth / rate-limit / unsupported → cascade to IndianAPI
 *   • Cache hit / miss
 *   • Envelope contract (provider, snapshots, data keys)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  getNseBatchLivePrice,
  getStockDetails,
  fetchNseDirectQuotes,
  kiteGetBatchQuotes,
  kiteGetQuote,
  memCache,
  marketOpen,
} = vi.hoisted(() => ({
  getNseBatchLivePrice: vi.fn(),
  getStockDetails: vi.fn(),
  fetchNseDirectQuotes: vi.fn(),
  kiteGetBatchQuotes: vi.fn(),
  kiteGetQuote: vi.fn(),
  memCache: new Map<string, unknown>(),
  marketOpen: { value: true },
}));

vi.mock('@/lib/marketData/providers/indianApiProvider', () => ({
  getNseBatchLivePrice,
  getStockDetails,
}));

vi.mock('@/lib/marketData/providers/nseDirectProvider', () => ({
  fetchNseDirectQuotes,
}));

vi.mock('@/providers/adapters/KiteAdapter', () => ({
  getBatchQuotes: kiteGetBatchQuotes,
  getQuote: kiteGetQuote,
  getHistorical: vi.fn(),
  searchSymbol: vi.fn(),
  getMovers: vi.fn(),
}));

vi.mock('@/lib/cache', async () => {
  const actual = await vi.importActual<typeof import('@/lib/cache')>('@/lib/cache');
  return {
    ...actual,
    cache: {
      get: vi.fn(async (key: string) => memCache.get(key) ?? null),
      set: vi.fn(async (key: string, val: unknown) => { memCache.set(key, val); }),
    },
  };
});

vi.mock('@/lib/marketData/marketHours', async () => {
  const actual = await vi.importActual<typeof import('@/lib/marketData/marketHours')>(
    '@/lib/marketData/marketHours',
  );
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

vi.mock('@/lib/marketData/nifty500Universe', () => ({
  isInNifty500: () => true,
}));

import { resolveBatch } from '@/lib/marketData/resolver/marketDataResolver';
import { quoteCacheKey } from '@/lib/cache';
import { UnsupportedFeatureError } from '@/providers/adapters/UnsupportedFeatureError';
import {
  KiteAuthenticationError,
  KiteRateLimitError,
} from '@/lib/kite/errors';

function makeSnap(sym: string, price: number) {
  return {
    symbol: sym, price, ltp: price, change: 0, changePercent: 0,
    volume: 1, open: price, high: price, low: price, prevClose: price,
    timestamp: Date.now(),
  };
}

function okIndianInv(snaps: ReturnType<typeof makeSnap>[]) {
  return {
    provider: 'indianapi' as const,
    endpoint: 'stock(emulated_batch)',
    requestStartedAt: new Date().toISOString(),
    responseReceivedAt: new Date().toISOString(),
    latencyMs: 40,
    status: 'success' as const,
    dataQuality: 'HIGH' as const,
    symbolsRequested: snaps.length,
    symbolsReturned: snaps.length,
    coveragePercent: 100,
    staleSymbols: [] as string[],
    failedSymbols: [] as string[],
    errorCode: null,
    errorMessage: null,
    data: { snapshots: snaps, missing: [] as string[] },
  };
}

beforeEach(() => {
  process.env.INDIANAPI_PRIMARY = 'true';
  process.env.MARKET_DATA_PROVIDER = 'indianapi';
  process.env.NIFTY500_LOCK = '0';
  process.env.MARKET_CLOSED_RESOLVER_GATE = '0';
  marketOpen.value = true;
  memCache.clear();
  getNseBatchLivePrice.mockReset();
  getStockDetails.mockReset();
  fetchNseDirectQuotes.mockReset();
  kiteGetBatchQuotes.mockReset();
  kiteGetQuote.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('resolveBatch — Phase 5 provider selection', () => {
  it('IndianAPI default: never calls Kite', async () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    process.env.MARKET_DATA_PROVIDER = 'indianapi';
    getNseBatchLivePrice.mockResolvedValue(okIndianInv([makeSnap('RELIANCE', 2500)]));

    const r = await resolveBatch(['RELIANCE'], { forceRefresh: true });

    expect(r.provider).toBe('indianapi');
    expect(r.status).toBe('success');
    expect(r.snapshots.get('RELIANCE')?.price).toBe(2500);
    expect(r.data['NSE:RELIANCE']?.ltp).toBe(2500);
    expect(r.fallbackUsed).toBe(false);
    expect(kiteGetBatchQuotes).not.toHaveBeenCalled();
    expect(getNseBatchLivePrice).toHaveBeenCalled();
  });

  it('MARKET_DATA_PROVIDER=kite serves from KiteAdapter', async () => {
    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';
    kiteGetBatchQuotes.mockResolvedValue({
      snapshots: [makeSnap('TCS', 4100)],
      missing: [],
    });

    const r = await resolveBatch(['TCS'], { forceRefresh: true });

    expect(r.provider).toBe('kite');
    expect(r.status).toBe('success');
    expect(r.snapshots.get('TCS')?.price).toBe(4100);
    expect(r.data['NSE:TCS']?.source).toBe('kite');
    expect(r.fallbackUsed).toBe(false);
    expect(kiteGetBatchQuotes).toHaveBeenCalled();
    expect(getNseBatchLivePrice).not.toHaveBeenCalled();
  });

  it('KiteAuthenticationError falls back to IndianAPI', async () => {
    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';
    kiteGetBatchQuotes.mockRejectedValue(
      new KiteAuthenticationError('token expired'),
    );
    getNseBatchLivePrice.mockResolvedValue(okIndianInv([makeSnap('INFY', 1500)]));

    const r = await resolveBatch(['INFY'], { forceRefresh: true });

    expect(kiteGetBatchQuotes).toHaveBeenCalled();
    expect(getNseBatchLivePrice).toHaveBeenCalled();
    expect(r.provider).toBe('indianapi');
    expect(r.fallbackUsed).toBe(true);
    expect(r.snapshots.get('INFY')?.price).toBe(1500);
  });

  it('KiteRateLimitError falls back to IndianAPI', async () => {
    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';
    kiteGetBatchQuotes.mockRejectedValue(
      new KiteRateLimitError('too many requests'),
    );
    getNseBatchLivePrice.mockResolvedValue(okIndianInv([makeSnap('SBIN', 800)]));

    const r = await resolveBatch(['SBIN'], { forceRefresh: true });

    expect(r.provider).toBe('indianapi');
    expect(r.fallbackUsed).toBe(true);
    expect(r.snapshots.get('SBIN')?.price).toBe(800);
  });

  it('UnsupportedFeatureError falls back to IndianAPI', async () => {
    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';
    kiteGetBatchQuotes.mockRejectedValue(
      new UnsupportedFeatureError('getBatchQuotes', 'not available'),
    );
    getNseBatchLivePrice.mockResolvedValue(okIndianInv([makeSnap('HDFCBANK', 1600)]));

    const r = await resolveBatch(['HDFCBANK'], { forceRefresh: true });

    expect(r.provider).toBe('indianapi');
    expect(r.fallbackUsed).toBe(true);
    expect(r.snapshots.get('HDFCBANK')?.price).toBe(1600);
  });

  it('cache hit: zero upstream calls (IndianAPI default)', async () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    memCache.set(quoteCacheKey('RELIANCE'), makeSnap('RELIANCE', 2500));
    memCache.set(quoteCacheKey('TCS'), makeSnap('TCS', 4000));

    const r = await resolveBatch(['RELIANCE', 'TCS']);

    expect(r.provider).toBe('cache');
    expect(r.status).toBe('success');
    expect(r.coveragePercent).toBe(100);
    expect(getNseBatchLivePrice).not.toHaveBeenCalled();
    expect(kiteGetBatchQuotes).not.toHaveBeenCalled();
  });

  it('cache hit under kite primary: zero upstream calls', async () => {
    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';
    memCache.set(quoteCacheKey('RELIANCE'), makeSnap('RELIANCE', 2501));

    const r = await resolveBatch(['RELIANCE']);

    expect(r.provider).toBe('cache');
    expect(kiteGetBatchQuotes).not.toHaveBeenCalled();
    expect(getNseBatchLivePrice).not.toHaveBeenCalled();
  });

  it('cache miss under kite primary hits Kite', async () => {
    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';
    kiteGetBatchQuotes.mockResolvedValue({
      snapshots: [makeSnap('RELIANCE', 2510)],
      missing: [],
    });

    const r = await resolveBatch(['RELIANCE'], { forceRefresh: true });

    expect(r.provider).toBe('kite');
    expect(kiteGetBatchQuotes).toHaveBeenCalledWith(['RELIANCE']);
    expect(r.symbolsReturned).toBe(1);
  });

  it('response contract unchanged — Map snapshots + data record', async () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    getNseBatchLivePrice.mockResolvedValue(okIndianInv([makeSnap('RELIANCE', 2500)]));

    const r = await resolveBatch(['RELIANCE'], { forceRefresh: true });

    expect(r).toMatchObject({
      provider: expect.any(String),
      status: expect.any(String),
      dataQuality: expect.any(String),
      requestStartedAt: expect.any(String),
      responseReceivedAt: expect.any(String),
      latencyMs: expect.any(Number),
      symbolsRequested: 1,
      symbolsReturned: 1,
      coveragePercent: 100,
      fallbackUsed: false,
    });
    expect(r.snapshots).toBeInstanceOf(Map);
    expect(r.snapshots.get('RELIANCE')).toMatchObject({ symbol: 'RELIANCE', price: 2500 });
    expect(r.data['NSE:RELIANCE']).toMatchObject({
      ltp: 2500,
      source: 'indianapi',
      timestamp: expect.any(String),
    });
  });
});
