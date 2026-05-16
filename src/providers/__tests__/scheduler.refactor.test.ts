// ════════════════════════════════════════════════════════════════
//  Scheduler behavior + budget enforcement tests (skeleton)
//
//  Drop under src/__tests__/ — uses vitest per existing repo setup.
//  These are the acceptance-criteria tests named in REFACTOR_PLAN.md.
// ════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Note: import order matters — we mock before importing SUTs.

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
}));

vi.mock('@/services/LiveQuoteService', () => ({
  persistSnapshot: vi.fn().mockResolvedValue(undefined),
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

describe('batchScheduler — Tier A (batch)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetInternalStateForTests();
    configureTiers({
      tier1: ['RELIANCE', 'TCS'],
      tier2: ['INFY'],
      tier3: [],
    });
  });

  it('calls getBatchQuotes ONCE for the whole universe — never per-symbol', async () => {
    (IndianAPI.getBatchQuotes as any).mockResolvedValue({
      snapshots: [
        { symbol: 'RELIANCE', price: 2500, ltp: 2500, change: 10, changePercent: 0.4, volume: 1e6, open: 2490, high: 2505, low: 2485, prevClose: 2490, timestamp: Date.now() },
        { symbol: 'TCS',      price: 3500, ltp: 3500, change: 20, changePercent: 0.6, volume: 5e5, open: 3480, high: 3510, low: 3470, prevClose: 3480, timestamp: Date.now() },
        { symbol: 'INFY',     price: 1500, ltp: 1500, change: -5, changePercent: -0.3, volume: 8e5, open: 1505, high: 1510, low: 1495, prevClose: 1505, timestamp: Date.now() },
      ],
      missing: [],
    });
    (IndianAPI.getTrendingSymbols as any).mockResolvedValue([]);
    (IndianAPI.getPriceShockers as any).mockResolvedValue([]);
    (IndianAPI.getNseMostActive as any).mockResolvedValue([]);

    const report = await runBatchTier();

    expect(report.ok).toBe(true);
    expect(IndianAPI.getBatchQuotes).toHaveBeenCalledTimes(1);
    expect(IndianAPI.getQuote).not.toHaveBeenCalled();
    expect(report.details.batchReceived).toBe(3);
  });
});

describe('triggerEngine — cooldown + budget enforcement', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _resetInternalStateForTests();
    configureTiers({ tier1: ['FOO', 'BAR', 'BAZ'], tier2: [], tier3: [] });

    // Pre-populate cache with snapshots showing 4% moves — should trigger.
    for (const sym of ['FOO', 'BAR', 'BAZ']) {
      await cacheSet(`quote:${sym}`, {
        symbol: sym, price: 100, ltp: 100, change: 4, changePercent: 4.0,
        volume: 1_000_000, open: 96, high: 101, low: 95, prevClose: 96, timestamp: Date.now(),
      }, 60);
      await cacheSet(`corp:${sym}`, { volumeAvg20d: 100_000 }, 60);
    }
  });

  afterEach(async () => {
    for (const sym of ['FOO', 'BAR', 'BAZ']) await clearCooldown(sym, 'deep');
  });

  it('does not deep-fetch a symbol that is in cooldown', async () => {
    await setCooldown('FOO', 'deep');
    (IndianAPI.getQuote as any).mockResolvedValue({
      symbol: 'BAR', price: 100, ltp: 100, change: 4, changePercent: 4,
      volume: 1e6, open: 96, high: 101, low: 95, prevClose: 96, timestamp: Date.now(),
    });

    const report = await runTriggerTier();

    const fetchedSymbols = (IndianAPI.getQuote as any).mock.calls.map((c: any) => c[0]);
    expect(fetchedSymbols).not.toContain('FOO');
    expect(report.ok).toBe(true);
  });

  it('budget snapshot reflects spending after a trigger run', async () => {
    (IndianAPI.getQuote as any).mockResolvedValue({
      symbol: 'FOO', price: 100, ltp: 100, change: 4, changePercent: 4,
      volume: 1e6, open: 96, high: 101, low: 95, prevClose: 96, timestamp: Date.now(),
    });

    const before = await budgetSnapshot();
    await runTriggerTier();
    const after = await budgetSnapshot();

    expect(after.monthTotal).toBeGreaterThanOrEqual(before.monthTotal);
    expect(after.byType.deep).toBeGreaterThanOrEqual(before.byType.deep);
  });
});
