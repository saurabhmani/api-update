// ════════════════════════════════════════════════════════════════
//  Scheduler behavior + budget enforcement tests
//
//  Phase 7: live quote sync goes through MarketDataProvider only.
//  IndianAPIAdapter mocks remain for breaker metadata / legacy
//  batch path exercised via real MDP when not fully mocked.
// ════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const {
  getBatchLiveSnapshots,
  getLiveSnapshot,
  getTrendingSymbols,
  getPriceShockers,
  getNseMostActive,
} = vi.hoisted(() => ({
  getBatchLiveSnapshots: vi.fn(),
  getLiveSnapshot: vi.fn(),
  getTrendingSymbols: vi.fn(),
  getPriceShockers: vi.fn(),
  getNseMostActive: vi.fn(),
}));

vi.mock('@/providers/MarketDataProvider', () => ({
  default: {
    getBatchLiveSnapshots,
    getLiveSnapshot,
    getTrendingSymbols,
    getPriceShockers,
    getNseMostActive,
    getMarketNews: vi.fn(),
    getCompanyNews: vi.fn(),
    getHistorical: vi.fn(),
  },
  getBatchLiveSnapshots,
  getLiveSnapshot,
  getTrendingSymbols,
  getPriceShockers,
  getNseMostActive,
}));

vi.mock('@/providers/adapters/IndianAPIAdapter', () => ({
  getQuote:           vi.fn(),
  getBatchQuotes:     vi.fn(),
  getTrendingSymbols: vi.fn(),
  getPriceShockers:   vi.fn(),
  getNseMostActive:   vi.fn(),
  getMarketNews:      vi.fn(),
  getCompanyNews:     vi.fn(),
  getHistorical:      vi.fn(),
  getMovers:          vi.fn(),
  getCorporateIntel:  vi.fn(),
  getFundamentals:    vi.fn(),
  getIndustryPeers:   vi.fn(),
  searchSymbol:       vi.fn(),
  indianApiBreakerState: () => ({
    open: false, state: 'closed', remainingMs: 0,
    auth_failed: false, auth_failed_for_ms: 0,
  }),
}));

vi.mock('@/services/LiveQuoteService', () => ({
  persistSnapshot: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/marketData/nifty500Universe', () => ({
  isNifty500Initialized: () => true,
  initNifty500UniverseFromDb: vi.fn(),
}));

import * as IndianAPI from '@/providers/adapters/IndianAPIAdapter';
import { runBatchTier, runTriggerTier } from '@/lib/marketData/providers/batchScheduler';
import { configureTiers } from '@/lib/marketData/schedulerConfig';
import {
  snapshot as budgetSnapshot,
  _resetInternalStateForTests,
} from '@/lib/marketData/apiBudgetGuard';
import { setCooldown, clearCooldown } from '@/lib/marketData/cooldownStore';
import { cacheSet } from '@/lib/redis';

function snap(symbol: string, price = 100) {
  return {
    symbol, price, ltp: price, change: 4, changePercent: 4.0,
    volume: 1_000_000, open: 96, high: 101, low: 95, prevClose: 96, timestamp: Date.now(),
  };
}

describe('batchScheduler — Tier A (batch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetInternalStateForTests();
    process.env.INDIANAPI_PRIMARY = 'true';
    configureTiers({
      tier1: ['RELIANCE', 'TCS'],
      tier2: ['INFY'],
      tier3: [],
    });
    getTrendingSymbols.mockResolvedValue({ data: [] });
    getPriceShockers.mockResolvedValue({ data: [] });
    getNseMostActive.mockResolvedValue({ data: [] });
  });

  it('calls getBatchLiveSnapshots ONCE for the whole universe — never per-symbol getQuote', async () => {
    getBatchLiveSnapshots.mockResolvedValue({
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
    expect(getBatchLiveSnapshots).toHaveBeenCalledTimes(1);
    expect(getLiveSnapshot).not.toHaveBeenCalled();
    expect(IndianAPI.getQuote).not.toHaveBeenCalled();
    expect(report.details.batchReceived).toBe(3);
  });
});

describe('triggerEngine — cooldown + budget enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _resetInternalStateForTests();
    process.env.INDIANAPI_PRIMARY = 'true';
    configureTiers({ tier1: ['FOO', 'BAR', 'BAZ'], tier2: [], tier3: [] });

    for (const sym of ['FOO', 'BAR', 'BAZ']) {
      await cacheSet(`quote:${sym}`, snap(sym), 60);
      await cacheSet(`corp:${sym}`, { volumeAvg20d: 100_000 }, 60);
    }

    getLiveSnapshot.mockImplementation(async (sym: string) => ({
      data: snap(sym),
      source: 'indian',
      data_quality: 'near-live',
      fetched_at: Date.now(),
      provider_name: 'IndianAPI',
      source_type: 'primary',
      vendor_timestamp: Date.now(),
      freshness_ms: 0,
      fallback_reason: null,
    }));
  });

  afterEach(async () => {
    for (const sym of ['FOO', 'BAR', 'BAZ']) await clearCooldown(sym, 'deep');
  });

  it('does not deep-fetch a symbol that is in cooldown', async () => {
    await setCooldown('FOO', 'deep');

    const report = await runTriggerTier();

    const fetchedSymbols = getLiveSnapshot.mock.calls.map((c: unknown[]) => c[0]);
    expect(fetchedSymbols).not.toContain('FOO');
    expect(report.ok).toBe(true);
    expect(IndianAPI.getQuote).not.toHaveBeenCalled();
  });

  it('budget snapshot reflects spending after a trigger run', async () => {
    const before = await budgetSnapshot();
    await runTriggerTier();
    const after = await budgetSnapshot();

    expect(after.monthTotal).toBeGreaterThanOrEqual(before.monthTotal);
    expect(after.byType.deep).toBeGreaterThanOrEqual(before.byType.deep);
    expect(getLiveSnapshot).toHaveBeenCalled();
  });
});
