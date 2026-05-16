/**
 * Provider report contract tests (SMART_FALLBACK §6 + §7).
 *
 *   §1  market closed   → snapshot_calls bumps, no upstream call
 *   §2  IndianAPI primary → indianapi_calls bumps, last_provider='indianapi'
 *   §3  HTTP_409          → indianapi_calls bumps once, last_error='HTTP_409',
 *                           cascade suppressed, NSE/Yahoo NOT called
 *   §6  envelope helper   → emits {provider_used, fallback_used,
 *                           market_state, symbols_processed}
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

import { resolveBatch, buildSmartFallbackEnvelope } from '@/lib/marketData/resolver/marketDataResolver';
import {
  getProviderReport,
  _resetProviderReportForTests,
} from '@/lib/marketData/providerReport';

beforeEach(() => {
  process.env.INDIANAPI_PRIMARY = 'true';
  marketOpen.value = true;
  memCache.clear();
  getNseBatchLivePrice.mockReset();
  fetchNseDirectQuotes.mockReset();
  _resetProviderReportForTests();
});

afterEach(() => { vi.useRealTimers(); });

function makeSnap(sym: string, price: number) {
  return {
    symbol: sym, price, ltp: price, change: 0, changePercent: 0,
    volume: 1, open: price, high: price, low: price, prevClose: price,
    timestamp: Date.now(),
  };
}

function successInv(symbols: string[]) {
  return {
    provider: 'indianapi' as const,
    endpoint: 'stock(emulated_batch)',
    requestStartedAt: new Date().toISOString(),
    responseReceivedAt: new Date().toISOString(),
    latencyMs: 50,
    status: 'success' as const,
    dataQuality: 'HIGH' as const,
    symbolsRequested: symbols.length,
    symbolsReturned: symbols.length,
    coveragePercent: 100,
    staleSymbols: [],
    failedSymbols: [],
    freshnessScore: 90,
    errorCode: null,
    errorMessage: null,
    data: { snapshots: symbols.map((s) => makeSnap(s, 100)), missing: [] },
  };
}

function failedInv(errorCode: string) {
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
    errorMessage: `mock ${errorCode}`,
    data: null,
  };
}

describe('providerReport — counter wiring', () => {
  it('IndianAPI success bumps indianapi_calls and sets last_provider', async () => {
    getNseBatchLivePrice.mockResolvedValue(successInv(['RELIANCE']));
    await resolveBatch(['RELIANCE']);
    const r = getProviderReport();
    expect(r.indianapi_calls).toBe(1);
    expect(r.nse_calls).toBe(0);
    expect(r.yahoo_calls).toBe(0);
    expect(r.last_provider).toBe('indianapi');
    expect(r.fallback_triggered).toBe(false);
    expect(r.last_error).toBeNull();
  });

  it('HTTP_409 bumps indianapi_calls EXACTLY ONCE and records last_error without cascading', async () => {
    getNseBatchLivePrice.mockResolvedValue(failedInv('HTTP_409'));
    await resolveBatch(['RELIANCE']);
    const r = getProviderReport();
    // The single attempt must be counted once — not twice (the bug
    // updateLastError protects against).
    expect(r.indianapi_calls).toBe(1);
    expect(r.nse_calls).toBe(0);
    expect(r.yahoo_calls).toBe(0);
    expect(r.last_provider).toBe('indianapi');
    expect(r.last_error).toBe('HTTP_409');
    expect(r.fallback_triggered).toBe(false);
    expect(fetchNseDirectQuotes).not.toHaveBeenCalled();
  });

  it('market closed bumps snapshot_calls only', async () => {
    marketOpen.value = false;
    await resolveBatch(['RELIANCE']);
    const r = getProviderReport();
    expect(r.indianapi_calls).toBe(0);
    expect(r.nse_calls).toBe(0);
    expect(r.yahoo_calls).toBe(0);
    expect(r.snapshot_calls).toBe(1);
    expect(r.last_provider).toBe('snapshot');
    expect(r.fallback_triggered).toBe(false);
    expect(getNseBatchLivePrice).not.toHaveBeenCalled();
    expect(fetchNseDirectQuotes).not.toHaveBeenCalled();
  });
});

describe('buildSmartFallbackEnvelope — §6 shape', () => {
  it('produces the spec shape with market_state from current clock', async () => {
    getNseBatchLivePrice.mockResolvedValue(successInv(['RELIANCE']));
    const r = await resolveBatch(['RELIANCE']);
    const env = buildSmartFallbackEnvelope(r);
    expect(env).toEqual({
      provider_used:     'indianapi',
      fallback_used:     false,
      market_state:      'open',
      symbols_processed: 1,
    });
  });

  it('reports market_state="closed" + provider_used="snapshot" off-hours', async () => {
    marketOpen.value = false;
    const r = await resolveBatch(['RELIANCE']);
    const env = buildSmartFallbackEnvelope(r);
    expect(env.market_state).toBe('closed');
    expect(env.provider_used).toBe('snapshot');
    expect(env.fallback_used).toBe(false);
  });
});
