// ════════════════════════════════════════════════════════════════
//  IndianAPI ingestion orchestrator — mocked-adapter integration tests.
//
//  The adapter module is fully mocked (no HTTP, no limiter waits);
//  Redis is disabled (in-process fallback) and MySQL is a recording
//  stub. What we verify is ORCHESTRATION:
//    • Feature-flag / credential gates are loud (throw, never no-op).
//    • Held ingest lock → run SKIPS (no pile-up).
//    • Per-symbol mode persists snapshots to cache + LiveQuoteService
//      and records per-symbol sync state.
//    • Partial failures are counted and dead-lettered, run completes.
//    • Batch mode consumes chunked batch calls; missing symbols fail.
//    • Budget exhaustion aborts the run (aborted=true).
//    • Checkpoint resume skips already-processed symbols.
//    • Movers ingestion caches gainers/losers/most-active.
// ════════════════════════════════════════════════════════════════

import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';
import type { MarketSnapshot } from '@/types/market';

const dbCalls = vi.hoisted(() => [] as Array<{ sql: string; args: unknown[] }>);

vi.mock('@/lib/db', () => ({
  db: {
    query: vi.fn(async (sql: string, args: unknown[] = []) => {
      dbCalls.push({ sql, args });
      return { rows: [] as unknown[] };
    }),
  },
}));

vi.mock('@/services/LiveQuoteService', () => ({
  persistSnapshot: vi.fn(async () => {}),
}));

vi.mock('@/lib/marketData/nifty500Universe', () => ({
  isNifty500Initialized: vi.fn(() => true),
  initNifty500UniverseFromDb: vi.fn(async () => {}),
  getNifty500Symbols: vi.fn(() => ['AAA', 'BBB', 'CCC', 'DDD', 'EEE']),
}));

vi.mock('@/providers/adapters/IndianAPIAdapter', () => {
  class IndianApiConfigError extends Error {
    constructor(message: string) { super(message); this.name = 'IndianApiConfigError'; }
  }
  class IndianApiRateLimitError extends Error {
    constructor(public readonly retryAfterMs: number, endpoint: string) {
      super(`429 on ${endpoint}`); this.name = 'IndianApiRateLimitError';
    }
  }
  class IndianApiHttpError extends Error {
    constructor(message: string, public readonly statusCode: number | null, public readonly transient: boolean) {
      super(message); this.name = 'IndianApiHttpError';
    }
  }
  return {
    IndianApiConfigError,
    IndianApiRateLimitError,
    IndianApiHttpError,
    INDIANAPI_PROVIDER_NAME: 'indianapi',
    getStockDetail: vi.fn(),
    getBatchQuotes: vi.fn(),
    probeBatchEndpoint: vi.fn(),
    getMovers: vi.fn(),
    getHistorical: vi.fn(),
    getVendorUsage: vi.fn(),
  };
});

import * as IndianApi from '@/providers/adapters/IndianAPIAdapter';
import { IndianApiConfigError, IndianApiHttpError } from '@/providers/adapters/IndianAPIAdapter';
import { ApiBudgetExceededError, resetIndianApiUsageForTests } from '@/providers/adapters/indianApiUsageTracker';
import { persistSnapshot } from '@/services/LiveQuoteService';
import {
  runQuoteIngestion,
  runMoversIngestion,
  runRepairIngestion,
  fetchHistoricalSeries,
  wrapIndianApiSnapshot,
  backoffDelayMs,
} from '@/lib/marketData/ingestion/indianApiIngestionOrchestrator';
import { resetIndianApiRateLimiterForTests } from '@/lib/marketData/providers/indianApiRateLimiter';
import { cacheAcquireLock, cacheReleaseLock, cacheGet, cacheSet } from '@/lib/redis';
import { quoteCacheKey, moversCacheKey } from '@/lib/cache';

const ENV_KEYS = [
  'MARKET_DATA_PROVIDER', 'INDIANAPI_ENABLED', 'INDIANAPI_API_KEY',
  'INDIANAPI_BATCH_ENABLED', 'INDIANAPI_BATCH_SIZE',
  'INDIANAPI_MAX_CONCURRENCY', 'INDIANAPI_MAX_RETRIES', 'INDIANAPI_RPS_GLOBAL',
  'INDIANAPI_PER_RUN_LIMIT', 'INDIANAPI_DAILY_SOFT_LIMIT', 'INDIANAPI_MONTHLY_LIMIT',
  'INDIANAPI_INGEST_SYMBOL_LIMIT', 'REDIS_DISABLED',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function snap(symbol: string, price = 100): MarketSnapshot {
  return {
    symbol, price, ltp: price, change: 1, changePercent: 1,
    volume: 1000, open: price, high: price, low: price,
    prevClose: price - 1, timestamp: Date.now(),
  };
}

const mockedGetStockDetail = vi.mocked(IndianApi.getStockDetail);
const mockedGetBatchQuotes = vi.mocked(IndianApi.getBatchQuotes);
const mockedGetMovers = vi.mocked(IndianApi.getMovers);
const mockedGetHistorical = vi.mocked(IndianApi.getHistorical);

beforeEach(() => {
  process.env.REDIS_DISABLED = '1';
  process.env.INDIANAPI_ENABLED = 'true';
  process.env.INDIANAPI_API_KEY = 'test-key';
  process.env.INDIANAPI_BATCH_ENABLED = 'off';
  process.env.INDIANAPI_MAX_CONCURRENCY = '2';
  process.env.INDIANAPI_MAX_RETRIES = '0';      // no retry sleeps in tests
  process.env.INDIANAPI_RPS_GLOBAL = '1000';
  delete process.env.INDIANAPI_INGEST_SYMBOL_LIMIT;
  delete process.env.INDIANAPI_BATCH_SIZE;
  delete process.env.INDIANAPI_PER_RUN_LIMIT;

  dbCalls.length = 0;
  vi.mocked(persistSnapshot).mockClear();
  mockedGetStockDetail.mockReset();
  mockedGetBatchQuotes.mockReset();
  mockedGetMovers.mockReset();
  mockedGetHistorical.mockReset();
  resetIndianApiUsageForTests();
  resetIndianApiRateLimiterForTests();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function stockDetailFor(symbol: string) {
  return {
    snapshot: snap(symbol),
    intel: { symbol, companyName: `${symbol} Ltd` },
  };
}

describe('configuration gates', () => {
  it('throws loudly when the feature flag is off', async () => {
    delete process.env.INDIANAPI_ENABLED;
    await expect(runQuoteIngestion()).rejects.toBeInstanceOf(IndianApiConfigError);
  });

  it('throws loudly when credentials are missing', async () => {
    delete process.env.INDIANAPI_API_KEY;
    await expect(runQuoteIngestion()).rejects.toBeInstanceOf(IndianApiConfigError);
  });
});

describe('runQuoteIngestion — per-symbol mode', () => {
  it('skips when the ingest lock is held (no pile-up)', async () => {
    const held = await cacheAcquireLock('indianapi:ingest:lock:quotes', 'other-run', 60);
    expect(held).toBe(true);
    try {
      const report = await runQuoteIngestion();
      expect(report.skipped).toBe(true);
      expect(report.skipReason).toBe('lock_held');
      expect(mockedGetStockDetail).not.toHaveBeenCalled();
    } finally {
      await cacheReleaseLock('indianapi:ingest:lock:quotes', 'other-run');
    }
  });

  it('ingests the whole universe: cache write + persistSnapshot + sync state', async () => {
    mockedGetStockDetail.mockImplementation(async (symbol: string) => stockDetailFor(symbol));

    const report = await runQuoteIngestion({ resume: false });
    expect(report.skipped).toBe(false);
    expect(report.aborted).toBe(false);
    expect(report.totalSymbols).toBe(5);
    expect(report.processed).toBe(5);
    expect(report.failed).toBe(0);
    expect(report.batchMode).toBe(false);

    // Quote landed in the cache under the canonical key.
    const cached = await cacheGet<MarketSnapshot>(quoteCacheKey('AAA'));
    expect(cached?.symbol).toBe('AAA');

    // Envelope-wrapped snapshot persisted for every symbol.
    expect(persistSnapshot).toHaveBeenCalledTimes(5);
    const envelope = vi.mocked(persistSnapshot).mock.calls[0][0];
    expect(envelope.source).toBe('indianapi');
    expect(envelope.provider_name).toBe('IndianAPI');

    // Sync-state success upserts hit MySQL.
    const successUpserts = dbCalls.filter(c => c.sql.includes('indianapi_symbol_sync_state') && c.sql.includes('consecutive_failures = 0'));
    expect(successUpserts.length).toBe(5);
  });

  it('counts partial failures and dead-letters the failing symbol', async () => {
    mockedGetStockDetail.mockImplementation(async (symbol: string) => {
      if (symbol === 'CCC') {
        throw new IndianApiHttpError('boom', 400, false);
      }
      return stockDetailFor(symbol);
    });

    const report = await runQuoteIngestion({ resume: false });
    expect(report.processed).toBe(4);
    expect(report.failed).toBe(1);
    expect(report.aborted).toBe(false);

    const failureUpserts = dbCalls.filter(c =>
      c.sql.includes('consecutive_failures = consecutive_failures + 1')
      && (c.args as string[])[0] === 'CCC',
    );
    expect(failureUpserts.length).toBe(1);
  });

  it('aborts the run when the API budget is exhausted', async () => {
    let calls = 0;
    mockedGetStockDetail.mockImplementation(async (symbol: string) => {
      calls += 1;
      if (calls > 2) throw new ApiBudgetExceededError('daily', 10, 10);
      return stockDetailFor(symbol);
    });

    const report = await runQuoteIngestion({ resume: false });
    expect(report.aborted).toBe(true);
    expect(report.processed).toBeLessThan(5);
  });

  it('resumes from a persisted checkpoint instead of re-spending quota', async () => {
    await cacheSet('indianapi:ingest:checkpoint:quotes', {
      runId: 'previous-run', index: 3, total: 5, at: Date.now(),
    }, 600);
    mockedGetStockDetail.mockImplementation(async (symbol: string) => stockDetailFor(symbol));

    const report = await runQuoteIngestion(); // resume defaults on
    expect(report.resumedFrom).toBe(3);
    expect(report.processed).toBe(2); // only DDD + EEE
    const fetched = mockedGetStockDetail.mock.calls.map(c => c[0]).sort();
    expect(fetched).toEqual(['DDD', 'EEE']);
  });

  it('honors INDIANAPI_INGEST_SYMBOL_LIMIT (staging subset)', async () => {
    process.env.INDIANAPI_INGEST_SYMBOL_LIMIT = '2';
    mockedGetStockDetail.mockImplementation(async (symbol: string) => stockDetailFor(symbol));
    const report = await runQuoteIngestion({ resume: false });
    expect(report.totalSymbols).toBe(2);
    expect(report.processed).toBe(2);
  });
});

describe('runQuoteIngestion — batch mode', () => {
  it('uses chunked batch calls and fails symbols missing from the response', async () => {
    process.env.INDIANAPI_BATCH_ENABLED = 'on';
    process.env.INDIANAPI_BATCH_SIZE = '3';
    mockedGetBatchQuotes.mockImplementation(async (symbols: string[]) => ({
      snapshots: symbols.filter(s => s !== 'EEE').map(s => snap(s)),
      missing: symbols.filter(s => s === 'EEE'),
    }));

    const report = await runQuoteIngestion({ resume: false });
    expect(report.batchMode).toBe(true);
    expect(mockedGetBatchQuotes).toHaveBeenCalledTimes(2); // 5 symbols / 3 per chunk
    expect(report.processed).toBe(4);
    expect(report.failed).toBe(1);
    expect(mockedGetStockDetail).not.toHaveBeenCalled();
  });
});

describe('runMoversIngestion', () => {
  it('caches gainers/losers/most-active from the discovery endpoints', async () => {
    mockedGetMovers.mockResolvedValueOnce({
      gainers: [{ symbol: 'AAA', price: 10, changePercent: 5 }],
      losers: [{ symbol: 'BBB', price: 20, changePercent: -3 }],
      mostActive: [{ symbol: 'CCC', price: 30, changePercent: 1 }],
    });
    const report = await runMoversIngestion();
    expect(report).toMatchObject({ skipped: false, gainers: 1, losers: 1, mostActive: 1 });
    const cached = await cacheGet<{ gainers: unknown[] }>(moversCacheKey());
    expect(cached?.gainers).toHaveLength(1);
  });
});

describe('runRepairIngestion', () => {
  it('drains dead-lettered symbols and marks recoveries', async () => {
    const { db } = await import('@/lib/db');
    // The dead-letter SELECT returns two failing symbols; every other
    // statement (DDL, upserts) keeps the recording default.
    vi.mocked(db.query).mockImplementation(async (sql: string, args: unknown[] = []) => {
      dbCalls.push({ sql, args });
      if (/SELECT symbol FROM indianapi_symbol_sync_state/.test(sql)) {
        return { rows: [{ symbol: 'CCC' }, { symbol: 'DDD' }] };
      }
      return { rows: [] };
    });
    mockedGetStockDetail.mockImplementation(async (symbol: string) => {
      if (symbol === 'DDD') throw new IndianApiHttpError('still down', 500, true);
      return stockDetailFor(symbol);
    });

    const report = await runRepairIngestion(10);
    expect(report.skipped).toBe(false);
    expect(report.attempted).toBe(2);
    expect(report.recovered).toBe(1);
    expect(report.stillFailing).toBe(1);
  });
});

describe('fetchHistoricalSeries', () => {
  it('delegates to the adapter and records sync state', async () => {
    mockedGetHistorical.mockResolvedValueOnce({
      symbol: 'AAA', range: '1y', candles: [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 }],
    });
    const series = await fetchHistoricalSeries('AAA', '1y');
    expect(series.candles).toHaveLength(1);
    const upserts = dbCalls.filter(c => c.sql.includes('indianapi_symbol_sync_state'));
    expect(upserts.length).toBeGreaterThan(0);
  });
});

describe('helpers', () => {
  it('wrapIndianApiSnapshot produces a fully-populated envelope', () => {
    const resp = wrapIndianApiSnapshot(snap('AAA'));
    expect(resp.source).toBe('indianapi');
    expect(resp.source_type).toBe('primary');
    expect(resp.provider_name).toBe('IndianAPI');
    expect(resp.data_quality).toBe('near-live');
    expect(resp.fetched_at).toBeGreaterThan(0);
    expect(resp.freshness_ms).toBeGreaterThanOrEqual(0);
    expect(resp.fallback_reason).toBeNull();
  });

  it('backoffDelayMs applies full jitter under an exponential cap', () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const d = backoffDelayMs(attempt, 500);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(Math.min(500 * 2 ** attempt, 60_000));
    }
  });
});
