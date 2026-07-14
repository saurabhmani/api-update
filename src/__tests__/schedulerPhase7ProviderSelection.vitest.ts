/**
 * Phase 7 — batchScheduler provider-selection via MarketDataProvider.
 *
 * Covers:
 *   • IndianAPI default (MARKET_DATA_PROVIDER=indianapi)
 *   • Kite selected (MARKET_DATA_PROVIDER=kite)
 *   • Auth / rate-limit failure (MDP fallback; scheduler stays resilient)
 *   • Cache population (quote:<SYMBOL>)
 *   • No direct IndianAPI.getQuote from trigger tier
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const redisBox = { store: new Map<string, unknown>() };
  const marketOpen = { value: true };
  return {
    getBatchLiveSnapshots: vi.fn(),
    getLiveSnapshot: vi.fn(),
    getTrendingSymbols: vi.fn(),
    getPriceShockers: vi.fn(),
    getNseMostActive: vi.fn(),
    getMarketNews: vi.fn(),
    getCompanyNews: vi.fn(),
    getHistorical: vi.fn(),
    persistSnapshot: vi.fn().mockResolvedValue(undefined),
    redisBox,
    marketOpen,
  };
});

vi.mock('@/providers/MarketDataProvider', () => ({
  default: {
    getBatchLiveSnapshots: h.getBatchLiveSnapshots,
    getLiveSnapshot: h.getLiveSnapshot,
    getTrendingSymbols: h.getTrendingSymbols,
    getPriceShockers: h.getPriceShockers,
    getNseMostActive: h.getNseMostActive,
    getMarketNews: h.getMarketNews,
    getCompanyNews: h.getCompanyNews,
    getHistorical: h.getHistorical,
  },
  getBatchLiveSnapshots: h.getBatchLiveSnapshots,
  getLiveSnapshot: h.getLiveSnapshot,
  getTrendingSymbols: h.getTrendingSymbols,
  getPriceShockers: h.getPriceShockers,
  getNseMostActive: h.getNseMostActive,
  getMarketNews: h.getMarketNews,
  getCompanyNews: h.getCompanyNews,
  getHistorical: h.getHistorical,
}));

vi.mock('@/services/LiveQuoteService', () => ({
  persistSnapshot: h.persistSnapshot,
}));

vi.mock('@/lib/redis', () => ({
  cacheSet: vi.fn(async (key: string, val: unknown) => {
    h.redisBox.store.set(key, val);
  }),
  cacheGet: vi.fn(async (key: string) => h.redisBox.store.get(key) ?? null),
}));

vi.mock('@/lib/marketData/marketHours', async () => {
  const actual = await vi.importActual<typeof import('@/lib/marketData/marketHours')>(
    '@/lib/marketData/marketHours',
  );
  return {
    ...actual,
    isMarketOpen: () => h.marketOpen.value,
  };
});

vi.mock('@/lib/marketData/nifty500Universe', () => ({
  isNifty500Initialized: () => true,
  initNifty500UniverseFromDb: vi.fn(),
}));

vi.mock('@/providers/adapters/IndianAPIAdapter', () => ({
  getQuote: vi.fn(),
  getBatchQuotes: vi.fn(),
  indianApiBreakerState: () => ({
    open: false,
    state: 'closed',
    remainingMs: 0,
    auth_failed: false,
    auth_failed_for_ms: 0,
  }),
}));

import * as IndianAPI from '@/providers/adapters/IndianAPIAdapter';
import {
  runBatchTier,
  runTriggerTier,
  runHeartbeatTier,
} from '@/lib/marketData/providers/batchScheduler';
import { configureTiers } from '@/lib/marketData/schedulerConfig';
import { _resetInternalStateForTests } from '@/lib/marketData/apiBudgetGuard';
import { clearCooldown } from '@/lib/marketData/cooldownStore';

function snap(symbol: string, price = 100) {
  return {
    symbol,
    price,
    ltp: price,
    change: 4,
    changePercent: 4,
    volume: 1_000_000,
    open: price - 4,
    high: price + 1,
    low: price - 5,
    prevClose: price - 4,
    timestamp: Date.now(),
  };
}

function mdpEnvelope(symbol: string, source: 'indian' | 'kite' = 'indian') {
  const data = snap(symbol);
  return {
    data,
    source,
    data_quality: 'near-live' as const,
    fetched_at: Date.now(),
    provider_name: source === 'kite' ? 'Kite Connect' : 'IndianAPI',
    source_type: 'primary' as const,
    vendor_timestamp: Date.now(),
    freshness_ms: 0,
    fallback_reason: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.redisBox.store.clear();
  _resetInternalStateForTests();
  h.marketOpen.value = true;
  configureTiers({
    tier1: ['RELIANCE', 'TCS'],
    tier2: ['INFY'],
    tier3: [],
  });
  h.getTrendingSymbols.mockResolvedValue({ data: [], source: 'indian' });
  h.getPriceShockers.mockResolvedValue({ data: [], source: 'indian' });
  h.getNseMostActive.mockResolvedValue({ data: [], source: 'indian' });
  h.persistSnapshot.mockResolvedValue(undefined);
});

afterEach(async () => {
  for (const sym of ['RELIANCE', 'TCS', 'INFY', 'FOO', 'BAR', 'BAZ']) {
    await clearCooldown(sym, 'deep').catch(() => {});
  }
  delete process.env.MARKET_DATA_PROVIDER;
  delete process.env.INDIANAPI_PRIMARY;
});

describe('Phase 7 — scheduler uses IndianAPI via MarketDataProvider', () => {
  it('batch tier populates via MDP and never calls IndianAPI.getQuote', async () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    process.env.MARKET_DATA_PROVIDER = 'indianapi';

    h.getBatchLiveSnapshots.mockResolvedValue({
      entries: [
        { symbol: 'RELIANCE', snapshot: snap('RELIANCE', 2500), source: 'indian', data_quality: 'near-live' },
        { symbol: 'TCS', snapshot: snap('TCS', 3500), source: 'indian', data_quality: 'near-live' },
        { symbol: 'INFY', snapshot: snap('INFY', 1500), source: 'indian', data_quality: 'near-live' },
      ],
      batchCallsMade: 1,
      missingAfterBatch: [],
    });

    const report = await runBatchTier();
    expect(report.ok).toBe(true);
    expect(report.details.batchReceived).toBe(3);
    expect(h.getBatchLiveSnapshots).toHaveBeenCalledTimes(1);
    expect(IndianAPI.getQuote).not.toHaveBeenCalled();
    expect(h.persistSnapshot).toHaveBeenCalled();
  });
});

describe('Phase 7 — scheduler uses Kite via MarketDataProvider', () => {
  it('batch tier persists kite-sourced snapshots', async () => {
    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';

    h.getBatchLiveSnapshots.mockResolvedValue({
      entries: [
        { symbol: 'RELIANCE', snapshot: snap('RELIANCE', 2500), source: 'kite', data_quality: 'near-live' },
        { symbol: 'TCS', snapshot: snap('TCS', 3500), source: 'kite', data_quality: 'near-live' },
        { symbol: 'INFY', snapshot: snap('INFY', 1500), source: 'kite', data_quality: 'near-live' },
      ],
      batchCallsMade: 1,
      missingAfterBatch: [],
    });

    const report = await runBatchTier();
    expect(report.ok).toBe(true);
    expect(report.details.batchReceived).toBe(3);
    expect(h.persistSnapshot).toHaveBeenCalled();
    expect(h.persistSnapshot.mock.calls[0][0].source).toBe('kite');
  });
});

describe('Phase 7 — auth / rate-limit resilience', () => {
  it('trigger tier survives MDP auth failure without crashing', async () => {
    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';

    for (const sym of ['FOO', 'BAR', 'BAZ']) {
      h.redisBox.store.set(`quote:${sym}`, snap(sym));
      h.redisBox.store.set(`corp:${sym}`, { volumeAvg20d: 100_000 });
    }
    configureTiers({ tier1: ['FOO', 'BAR', 'BAZ'], tier2: [], tier3: [] });
    h.getLiveSnapshot.mockRejectedValue(new Error('KiteAuthenticationError: bad token'));

    const report = await runTriggerTier();
    expect(report.ok).toBe(true);
    expect(report.details.deepFetched).toBe(0);
    expect(IndianAPI.getQuote).not.toHaveBeenCalled();
  });

  it('trigger tier uses MDP forceRefresh and writes quote cache', async () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    process.env.MARKET_DATA_PROVIDER = 'indianapi';

    for (const sym of ['FOO', 'BAR', 'BAZ']) {
      h.redisBox.store.set(`quote:${sym}`, snap(sym));
      h.redisBox.store.set(`corp:${sym}`, { volumeAvg20d: 100_000 });
    }
    configureTiers({ tier1: ['FOO', 'BAR', 'BAZ'], tier2: [], tier3: [] });
    h.getLiveSnapshot.mockImplementation(async (sym: string) => mdpEnvelope(sym, 'indian'));

    const report = await runTriggerTier();
    expect(report.ok).toBe(true);
    expect(h.getLiveSnapshot).toHaveBeenCalled();
    expect(h.getLiveSnapshot.mock.calls.every((c) => c[1]?.forceRefresh === true)).toBe(true);
    expect(IndianAPI.getQuote).not.toHaveBeenCalled();
    expect([...h.redisBox.store.keys()].some((k) => k.startsWith('quote:'))).toBe(true);
  });

  it('rate-limit style failure still returns ok report (resilience)', async () => {
    process.env.MARKET_DATA_PROVIDER = 'kite';
    process.env.INDIANAPI_PRIMARY = 'false';

    for (const sym of ['FOO', 'BAR']) {
      h.redisBox.store.set(`quote:${sym}`, snap(sym));
      h.redisBox.store.set(`corp:${sym}`, { volumeAvg20d: 100_000 });
    }
    configureTiers({ tier1: ['FOO', 'BAR'], tier2: [], tier3: [] });
    h.getLiveSnapshot.mockRejectedValue(new Error('KiteRateLimitError: 429'));

    const report = await runTriggerTier();
    expect(report.ok).toBe(true);
    expect(report.error).toBeUndefined();
  });
});

describe('Phase 7 — heartbeat cache population', () => {
  it('skips upstream when cache is warm', async () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    for (const sym of ['RELIANCE', 'TCS', 'INFY']) {
      h.redisBox.store.set(`quote:${sym}`, snap(sym));
    }
    const report = await runHeartbeatTier();
    expect(report.ok).toBe(true);
    expect(report.details.cacheHits).toBe(3);
    expect(report.details.cacheMisses).toBe(0);
    expect(h.getBatchLiveSnapshots).not.toHaveBeenCalled();
  });

  it('refreshes cold cells via MDP when market is open', async () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    h.getBatchLiveSnapshots.mockResolvedValue({
      entries: [
        { symbol: 'RELIANCE', snapshot: snap('RELIANCE'), source: 'indian', data_quality: 'near-live' },
      ],
      batchCallsMade: 1,
      missingAfterBatch: ['TCS', 'INFY'],
    });
    const report = await runHeartbeatTier();
    expect(report.ok).toBe(true);
    expect(report.details.cacheMisses).toBe(3);
    expect(h.getBatchLiveSnapshots).toHaveBeenCalledTimes(1);
  });
});
