// ════════════════════════════════════════════════════════════════
//  scheduler behavior — covers the 3-tier runner, not the cron firing.
//
//  We don't test node-cron itself. What we test:
//    • runBatchTier calls getBatchLiveSnapshots exactly once and
//      reports the counts aggregated from the batch response.
//    • runBatchTier persists every 'indian'-source snapshot and
//      tolerates persistence failures (counts them, doesn't crash).
//    • A batch provider failure is surfaced cleanly in the report.
//    • runSchedulerPassOnce (legacy alias) maps to runBatchTier.
// ════════════════════════════════════════════════════════════════

import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/providers/MarketDataProvider', () => ({
  default: {
    getLiveSnapshot:        vi.fn(),
    getBatchLiveSnapshots:  vi.fn(),
    getTrendingSymbols:     vi.fn(),
    getPriceShockers:       vi.fn(),
    getNseMostActive:       vi.fn(),
    getMarketNews:          vi.fn(),
    getCompanyNews:         vi.fn(),
    getHistorical:          vi.fn(),
  },
}));
vi.mock('@/services/LiveQuoteService', () => ({
  persistSnapshot: vi.fn(),
}));

import MarketDataProvider from '@/providers/MarketDataProvider';
import * as LiveQuoteService from '@/services/LiveQuoteService';
import { runSchedulerPassOnce, configureWatchlist } from '@/lib/scheduler';
import type {
  MarketSnapshot,
  ProviderSource,
  DataQuality,
  ProviderSourceType,
  ProviderResponse,
} from '@/types/market';

const PROVIDER_NAMES: Record<ProviderSource, string> = {
  indian: 'IndianAPI', cache: 'Cache', yahoo: 'Yahoo Finance', db: 'PostgreSQL', kite: 'Kite (broker)',
};
const SOURCE_TYPES: Record<ProviderSource, ProviderSourceType> = {
  indian: 'primary', cache: 'cache', yahoo: 'fallback', db: 'stale', kite: 'primary',
};

function snap(sym: string): MarketSnapshot {
  return {
    symbol: sym, price: 100, ltp: 100, change: 0, changePercent: 0,
    volume: 0, open: 0, high: 0, low: 0, prevClose: 0, timestamp: Date.now(),
  };
}

function entry(
  sym: string,
  source: ProviderSource,
  data_quality: DataQuality,
): { symbol: string; snapshot: MarketSnapshot | null; source: ProviderSource; data_quality: DataQuality } {
  return { symbol: sym, snapshot: snap(sym), source, data_quality };
}

/** Build a canonical ProviderResponse for use as a vitest mock return. */
function resp<T>(data: T, source: ProviderSource, data_quality: DataQuality): ProviderResponse<T> {
  const now = Date.now();
  return {
    data,
    source,
    data_quality,
    fetched_at: now,
    provider_name: PROVIDER_NAMES[source],
    source_type: SOURCE_TYPES[source],
    vendor_timestamp: now,
    freshness_ms: 0,
    fallback_reason: null,
  };
}

describe('scheduler runBatchTier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    configureWatchlist(['AAA', 'BBB', 'CCC']);

    // Quiet the market-wide calls — they each resolve to something
    // harmless so the Tier A pass doesn't error on them.
    vi.mocked(MarketDataProvider.getTrendingSymbols).mockResolvedValue(resp([], 'cache', 'cached-fresh'));
    vi.mocked(MarketDataProvider.getPriceShockers  ).mockResolvedValue(resp([], 'cache', 'cached-fresh'));
    vi.mocked(MarketDataProvider.getNseMostActive  ).mockResolvedValue(resp([], 'cache', 'cached-fresh'));
  });

  it('issues a single batch call and reports received count', async () => {
    vi.mocked(MarketDataProvider.getBatchLiveSnapshots).mockResolvedValue({
      entries: [
        entry('AAA', 'indian', 'near-live'),
        entry('BBB', 'indian', 'near-live'),
        entry('CCC', 'indian', 'near-live'),
      ],
      batchCallsMade: 1,
      missingAfterBatch: [],
    });

    const report = await runSchedulerPassOnce();

    expect(report.ok).toBe(true);
    expect(MarketDataProvider.getBatchLiveSnapshots).toHaveBeenCalledTimes(1);
    expect(MarketDataProvider.getLiveSnapshot).not.toHaveBeenCalled();
    expect(report.details.batchReceived).toBe(3);
    expect(report.details.batchCallsMade).toBe(1);
    expect(report.details.batchMissing).toBe(0);
  });

  it('persists every indian-source snapshot', async () => {
    vi.mocked(MarketDataProvider.getBatchLiveSnapshots).mockResolvedValue({
      entries: [
        entry('AAA', 'indian', 'near-live'),
        entry('BBB', 'indian', 'near-live'),
        entry('CCC', 'cache',  'cached-fresh'),   // already cached — not persisted
      ],
      batchCallsMade: 1,
      missingAfterBatch: [],
    });

    await runSchedulerPassOnce();

    // Only the two 'indian' entries should be persisted; 'cache' skipped.
    expect(LiveQuoteService.persistSnapshot).toHaveBeenCalledTimes(2);
  });

  it('counts persistence failures without crashing the tier', async () => {
    vi.mocked(MarketDataProvider.getBatchLiveSnapshots).mockResolvedValue({
      entries: [
        entry('AAA', 'indian', 'near-live'),
        entry('BBB', 'indian', 'near-live'),
        entry('CCC', 'indian', 'near-live'),
      ],
      batchCallsMade: 1,
      missingAfterBatch: [],
    });
    vi.mocked(LiveQuoteService.persistSnapshot)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);

    const report = await runSchedulerPassOnce();

    expect(report.ok).toBe(true);
    expect(report.details.persistErrors).toBe(1);
  });

  it('surfaces a batch fetch failure cleanly', async () => {
    vi.mocked(MarketDataProvider.getBatchLiveSnapshots).mockRejectedValue(
      new Error('upstream 503'),
    );

    const report = await runSchedulerPassOnce();

    expect(report.ok).toBe(false);
    expect(report.error).toContain('upstream 503');
  });

  it('reports symbols missing from the batch response', async () => {
    vi.mocked(MarketDataProvider.getBatchLiveSnapshots).mockResolvedValue({
      entries: [
        entry('AAA', 'indian', 'near-live'),
        entry('BBB', 'indian', 'near-live'),
        { symbol: 'CCC', snapshot: null, source: 'db', data_quality: 'stale' },
      ],
      batchCallsMade: 1,
      missingAfterBatch: ['CCC'],
    });

    const report = await runSchedulerPassOnce();

    expect(report.details.batchReceived).toBe(2);
    expect(report.details.batchMissing).toBe(1);
  });
});
