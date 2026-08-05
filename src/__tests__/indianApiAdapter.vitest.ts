// ════════════════════════════════════════════════════════════════
//  IndianAPIAdapter — mocked-axios unit tests (zero real HTTP).
//
//  Covers the adapter contract the ingestion orchestrator depends on:
//    • Success paths map raw payloads to canonical types.
//    • Missing key → IndianApiConfigError BEFORE any HTTP.
//    • 401/403 → IndianApiConfigError (auth, not transient).
//    • 429 → IndianApiRateLimitError carrying Retry-After AND the
//      shared rate limiter is paused (queue-wide freeze).
//    • 404 → endpoint marked unavailable; subsequent calls
//      short-circuit without spending quota.
//    • 5xx transient / 4xx permanent classification.
//    • Budget gate rejects before dispatch when the daily cap is hit.
// ════════════════════════════════════════════════════════════════

import { describe, expect, it, vi, beforeEach, afterAll } from 'vitest';

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({ get: mockGet, post: mockPost })),
  },
}));

vi.mock('@/lib/marketData/providerRequestLog', () => ({
  logProviderRequest: vi.fn(async () => {}),
}));

import * as IndianApi from '@/providers/adapters/IndianAPIAdapter';
import {
  IndianApiConfigError,
  IndianApiHttpError,
  IndianApiRateLimitError,
  parseRetryAfterMs,
  resetIndianApiHttpClientForTests,
} from '@/providers/adapters/IndianAPIAdapter';
import {
  resetEndpointAvailabilityForTests,
} from '@/lib/marketData/providers/indianApiEndpoints';
import {
  getIndianApiRateLimiter,
  resetIndianApiRateLimiterForTests,
} from '@/lib/marketData/providers/indianApiRateLimiter';
import {
  resetIndianApiUsageForTests,
  incrementApiUsage,
} from '@/providers/adapters/indianApiUsageTracker';

const ENV_KEYS = [
  'INDIANAPI_API_KEY', 'INDIANAPI_KEY', 'INDIAN_API_KEY',
  'INDIANAPI_RPS_GLOBAL', 'INDIANAPI_MAX_CONCURRENCY',
  'INDIANAPI_DAILY_SOFT_LIMIT', 'INDIANAPI_MONTHLY_LIMIT',
  'REDIS_DISABLED',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

function axiosReject(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, headers, data: {} },
  });
}

beforeEach(() => {
  process.env.REDIS_DISABLED = '1';
  process.env.INDIANAPI_API_KEY = 'test-key';
  delete process.env.INDIANAPI_KEY;
  delete process.env.INDIAN_API_KEY;
  // Fast limiter so tests never wait on the 1s token window.
  process.env.INDIANAPI_RPS_GLOBAL = '1000';
  process.env.INDIANAPI_MAX_CONCURRENCY = '8';
  delete process.env.INDIANAPI_DAILY_SOFT_LIMIT;
  delete process.env.INDIANAPI_MONTHLY_LIMIT;

  mockGet.mockReset();
  mockPost.mockReset();
  resetIndianApiHttpClientForTests();
  resetEndpointAvailabilityForTests();
  resetIndianApiRateLimiterForTests();
  resetIndianApiUsageForTests();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('parseRetryAfterMs', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(0)).toBe(0);
  });
  it('caps at 5 minutes', () => {
    expect(parseRetryAfterMs('9999')).toBe(5 * 60_000);
  });
  it('falls back to 30s on junk / missing', () => {
    expect(parseRetryAfterMs(undefined)).toBe(30_000);
    expect(parseRetryAfterMs('garbage-not-a-date-123x')).toBe(30_000);
  });
  it('parses HTTP-date values relative to now', () => {
    const ms = parseRetryAfterMs(new Date(Date.now() + 10_000).toUTCString());
    expect(ms).toBeGreaterThan(5_000);
    expect(ms).toBeLessThanOrEqual(11_000);
  });
});

describe('IndianAPIAdapter — success paths', () => {
  it('getStockDetail maps /stock into snapshot + corporate intel', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        companyName: 'Reliance Industries',
        sector: 'Energy',
        currentPrice: { NSE: '2,955.60' },
        percentChange: '1.25',
        previousClose: '2,919.10',
        volume: '5,000,000',
      },
    });
    const { snapshot, intel } = await IndianApi.getStockDetail('RELIANCE', 'test');
    expect(mockGet).toHaveBeenCalledWith('/stock', { params: { name: 'RELIANCE' } });
    expect(snapshot.symbol).toBe('RELIANCE');
    expect(snapshot.price).toBe(2955.6);
    expect(intel.companyName).toBe('Reliance Industries');
    expect(intel.sector).toBe('Energy');
  });

  it('getBatchQuotes handles array payloads and reports missing symbols', async () => {
    mockPost.mockResolvedValueOnce({
      status: 200,
      data: [
        { symbol: 'TCS', price: '4,100.5' },
        { symbol: 'INFY', lastPrice: 1500 },
      ],
    });
    const { snapshots, missing } = await IndianApi.getBatchQuotes(['TCS', 'INFY', 'WIPRO'], 'test');
    expect(mockPost).toHaveBeenCalledWith(
      '/nse_stock_batch_live_price',
      { stock_symbols: ['TCS', 'INFY', 'WIPRO'] },
      { params: undefined },
    );
    expect(snapshots.map(s => s.symbol).sort()).toEqual(['INFY', 'TCS']);
    expect(missing).toEqual(['WIPRO']);
  });

  it('getBatchQuotes handles object-keyed payloads', async () => {
    mockPost.mockResolvedValueOnce({
      status: 200,
      data: { TCS: { price: 4100 }, INFY: { price: 1500 } },
    });
    const { snapshots, missing } = await IndianApi.getBatchQuotes(['TCS', 'INFY'], 'test');
    expect(snapshots).toHaveLength(2);
    expect(missing).toEqual([]);
  });

  it('getMovers survives a most-active failure (trending-only result)', async () => {
    mockGet
      .mockResolvedValueOnce({
        status: 200,
        data: {
          trending_stocks: {
            top_gainers: [{ ticker_id: 'ABC', price: 10, percent_change: 2 }],
            top_losers: [],
          },
        },
      })
      .mockRejectedValueOnce(axiosReject(500));
    const movers = await IndianApi.getMovers('test');
    expect(movers.gainers).toHaveLength(1);
    expect(movers.mostActive).toEqual([]);
  });

  it('getHistorical maps the close-only price series', async () => {
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        datasets: [{ metric: 'Price', values: [['2026-07-01', 100], ['2026-07-02', 101]] }],
      },
    });
    const series = await IndianApi.getHistorical('INFY', '1mo', 'test');
    expect(mockGet).toHaveBeenCalledWith('/historical_data', {
      params: { stock_name: 'INFY', period: '1m', filter: 'price' },
    });
    expect(series.candles).toHaveLength(2);
  });
});

describe('IndianAPIAdapter — error taxonomy', () => {
  it('missing API key → IndianApiConfigError before any HTTP', async () => {
    delete process.env.INDIANAPI_API_KEY;
    resetIndianApiHttpClientForTests();
    await expect(IndianApi.getStockDetail('TCS')).rejects.toBeInstanceOf(IndianApiConfigError);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('401 → IndianApiConfigError (auth failure, not retryable)', async () => {
    mockGet.mockRejectedValueOnce(axiosReject(401));
    await expect(IndianApi.getStockDetail('TCS')).rejects.toBeInstanceOf(IndianApiConfigError);
  });

  it('429 → IndianApiRateLimitError with Retry-After AND queue-wide pause', async () => {
    mockGet.mockRejectedValueOnce(axiosReject(429, { 'retry-after': '2' }));
    const err = await IndianApi.getStockDetail('TCS').catch(e => e);
    expect(err).toBeInstanceOf(IndianApiRateLimitError);
    expect((err as IndianApiRateLimitError).retryAfterMs).toBe(2000);
    // The SHARED limiter must be paused — 429 freezes the queue, not
    // just the failing request.
    expect(getIndianApiRateLimiter().pausedForMs).toBeGreaterThan(1000);
  });

  it('404 marks the endpoint unavailable — next call short-circuits without HTTP', async () => {
    mockGet.mockRejectedValueOnce(axiosReject(404));
    const first = await IndianApi.getStockDetail('TCS').catch(e => e);
    expect(first).toBeInstanceOf(IndianApiHttpError);
    expect((first as IndianApiHttpError).statusCode).toBe(404);
    expect(mockGet).toHaveBeenCalledTimes(1);

    const second = await IndianApi.getStockDetail('INFY').catch(e => e);
    expect(second).toBeInstanceOf(IndianApiHttpError);
    expect(mockGet).toHaveBeenCalledTimes(1); // no additional quota spent
  });

  it('5xx is transient; other 4xx is permanent', async () => {
    mockGet.mockRejectedValueOnce(axiosReject(503));
    const transient = await IndianApi.getStockDetail('TCS').catch(e => e);
    expect(transient).toBeInstanceOf(IndianApiHttpError);
    expect((transient as IndianApiHttpError).transient).toBe(true);

    mockGet.mockRejectedValueOnce(axiosReject(400));
    const permanent = await IndianApi.getStockDetail('TCS').catch(e => e);
    expect((permanent as IndianApiHttpError).transient).toBe(false);
  });

  it('probeBatchEndpoint returns false on 404 (plan without batch route)', async () => {
    mockPost.mockRejectedValueOnce(axiosReject(404));
    await expect(IndianApi.probeBatchEndpoint(['TCS', 'INFY'])).resolves.toBe(false);
  });
});

describe('IndianAPIAdapter — budget enforcement', () => {
  it('daily soft limit blocks BEFORE dispatching upstream', async () => {
    process.env.INDIANAPI_DAILY_SOFT_LIMIT = '2';
    await incrementApiUsage(2);
    const err = await IndianApi.getStockDetail('TCS').catch(e => e);
    expect(err).toBeInstanceOf(IndianApi.ApiBudgetExceededError);
    expect((err as InstanceType<typeof IndianApi.ApiBudgetExceededError>).bucket).toBe('daily');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('monthly hard limit freezes calls', async () => {
    process.env.INDIANAPI_MONTHLY_LIMIT = '1';
    await incrementApiUsage(1);
    const err = await IndianApi.getStockDetail('TCS').catch(e => e);
    expect(err).toBeInstanceOf(IndianApi.ApiBudgetExceededError);
    expect((err as InstanceType<typeof IndianApi.ApiBudgetExceededError>).bucket).toBe('monthly');
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('usage counters track dispatched attempts (success and failure)', async () => {
    mockGet
      .mockResolvedValueOnce({ status: 200, data: {} })
      .mockRejectedValueOnce(axiosReject(500));
    await IndianApi.getStockDetail('TCS').catch(() => {});
    await IndianApi.getStockDetail('INFY').catch(() => {});
    const usage = await IndianApi.getApiUsage();
    expect(usage.daily).toBe(2);
  });
});
