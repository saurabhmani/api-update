/**
 * Public Signals API — acceptance tests
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const dbQuery = vi.fn();
const cacheGet = vi.fn();
const cacheSet = vi.fn();
const enforceRateLimit = vi.fn();
const countPublicSignals = vi.fn();
const listPublicSignals = vi.fn();
const aggregatePublicSignalsSummary = vi.fn();

vi.mock('@/lib/db', () => ({
  db: { query: (...args: unknown[]) => dbQuery(...args) },
}));

vi.mock('@/lib/redis', () => ({
  cacheGet: (...args: unknown[]) => cacheGet(...args),
  cacheSet: (...args: unknown[]) => cacheSet(...args),
}));

vi.mock('@/lib/security/rateLimiter', () => ({
  enforceRateLimit: (...args: unknown[]) => enforceRateLimit(...args),
  RATE_LIMITS: {
    publicSignals: { windowMs: 60_000, max: 30, keyPrefix: 'public:signals' },
    publicSignalsKey: { windowMs: 60_000, max: 120, keyPrefix: 'public:signals:key' },
  },
}));

vi.mock('@/lib/signals/public/publicSignalsRepository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/signals/public/publicSignalsRepository')>();
  return {
    ...actual,
    countPublicSignals: (...args: unknown[]) => countPublicSignals(...args),
    listPublicSignals: (...args: unknown[]) => listPublicSignals(...args),
    aggregatePublicSignalsSummary: (...args: unknown[]) => aggregatePublicSignalsSummary(...args),
  };
});

import { GET } from '@/app/api/public/v1/signals/route';
import {
  buildPublicSignalsFilter,
  PUBLIC_SIGNALS_PUBLISHED_WHERE,
  PUBLIC_SIGNAL_DTO_FIELDS,
} from '@/lib/signals/public/publicSignalsRepository';
import {
  buildPublicSignalsCacheKey,
  parsePublicSignalsQuery,
  getPublicSignalsFeed,
} from '@/lib/signals/public/publicSignalsService';
import { ValidationError } from '@/lib/errors';
import { enforcePublicSignalsAccess } from '@/lib/signals/public/publicSignalsAccess';

const summary = {
  win_rate: 62.5,
  total_signals: 8,
  active_signals: 3,
  signals_this_month: 2,
  best_strategy: 'fibonacci_pullback',
  average_confidence: 71.2,
};

const sampleRow = {
  id: 1,
  symbol: 'RELIANCE',
  strategy_id: 'fibonacci_pullback',
  direction: 'BUY',
  entry_price: 2500,
  stop_loss: 2400,
  target_1: 2700,
  target_2: 2800,
  target_3: 2900,
  confidence_score: 72,
  created_at: '2026-06-01T10:00:00.000Z',
  outcome: 'T1_HIT',
  outcome_at: '2026-06-10T10:00:00.000Z',
  days_held: 7,
  max_gain_pct: 8.5,
};

function req(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('publicSignalsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    cacheGet.mockResolvedValue(null);
    cacheSet.mockResolvedValue(undefined);
    countPublicSignals.mockResolvedValue(8);
    listPublicSignals.mockResolvedValue([sampleRow]);
    aggregatePublicSignalsSummary.mockResolvedValue(summary);
  });

  it('parses pagination defaults', () => {
    const q = parsePublicSignalsQuery(req('/api/public/v1/signals'));
    expect(q.page).toBe(1);
    expect(q.limit).toBe(50);
    expect(q.sort).toBe('created_at');
    expect(q.sortDir).toBe('desc');
  });

  it('rejects invalid from_date', () => {
    expect(() => parsePublicSignalsQuery(req('/api/public/v1/signals?from_date=bad'))).toThrow(ValidationError);
  });

  it('rejects unknown outcome', () => {
    expect(() => parsePublicSignalsQuery(req('/api/public/v1/signals?outcome=FOO'))).toThrow(ValidationError);
  });

  it('rejects invalid symbol characters', () => {
    expect(() => parsePublicSignalsQuery(req('/api/public/v1/signals?symbol=RELIANCE;DROP'))).toThrow(ValidationError);
  });

  it('rejects invalid strategy characters', () => {
    expect(() => parsePublicSignalsQuery(req('/api/public/v1/signals?strategy=bad-strategy!'))).toThrow(ValidationError);
  });

  it('builds cache key from filters', () => {
    const key = buildPublicSignalsCacheKey({
      page: 2,
      limit: 25,
      strategy: 'fib',
      symbol: 'TCS',
      outcome: 'ACTIVE',
      fromDate: '2026-01-01',
      toDate: '2026-06-01',
      sort: 'confidence_score',
      sortDir: 'asc',
    });
    expect(key).toContain('page:2');
    expect(key).toContain('strategy:fib');
    expect(key).toContain('sort:confidence_score:asc');
  });

  it('throws 404 when page exceeds total', async () => {
    countPublicSignals.mockResolvedValue(10);
    await expect(getPublicSignalsFeed({
      page: 5,
      limit: 10,
      sort: 'created_at',
      sortDir: 'desc',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('applies dynamic SQL filters', () => {
    const { where, params } = buildPublicSignalsFilter({
      page: 1,
      limit: 50,
      strategy: 'fibonacci_pullback',
      symbol: 'RELIANCE',
      outcome: 'T1_HIT',
      fromDate: '2026-01-01',
      toDate: '2026-06-30',
      sort: 'created_at',
      sortDir: 'desc',
    });
    expect(where).toContain('APPROVED_SIGNAL');
    expect(where).toContain('COALESCE(o.strategy_id, s.signal_type) = ?');
    expect(where).toContain('s.symbol = ?');
    expect(where).toContain('o.outcome = ?');
    expect(params).toContain('fibonacci_pullback');
    expect(params).toContain('RELIANCE');
    expect(params).toContain('T1_HIT');
  });

  it('excludes unpublished classifications in base filter', () => {
    expect(PUBLIC_SIGNALS_PUBLISHED_WHERE).toContain('APPROVED_SIGNAL');
    expect(PUBLIC_SIGNALS_PUBLISHED_WHERE).toContain('UPPER(s.classification) IN');
    expect(PUBLIC_SIGNALS_PUBLISHED_WHERE).not.toContain('NO_TRADE');
  });

  it('exposes only public DTO fields', () => {
    expect(PUBLIC_SIGNAL_DTO_FIELDS).not.toContain('user_id');
    expect(PUBLIC_SIGNAL_DTO_FIELDS).not.toContain('batch_id');
    expect(PUBLIC_SIGNAL_DTO_FIELDS).toContain('strategy_id');
    expect(PUBLIC_SIGNAL_DTO_FIELDS).toContain('outcome');
  });
});

describe('GET /api/public/v1/signals', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    cacheGet.mockResolvedValue(null);
    cacheSet.mockResolvedValue(undefined);
    countPublicSignals.mockResolvedValue(1);
    listPublicSignals.mockResolvedValue([sampleRow]);
    aggregatePublicSignalsSummary.mockResolvedValue(summary);
  });

  it('returns paginated feed with summary', async () => {
    const res = await GET(req('/api/public/v1/signals?page=1&limit=10'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(body.page).toBe(1);
    expect(body.total).toBe(1);
    expect(body.win_rate).toBe(62.5);
    expect(body.summary.best_strategy).toBe('fibonacci_pullback');
    expect(body.data[0]).not.toHaveProperty('user_id');
    expect(body.data[0]).not.toHaveProperty('batch_id');
  });

  it('returns cached payload on cache hit', async () => {
    cacheGet.mockResolvedValue({
      data: [sampleRow],
      page: 1,
      total: 1,
      summary,
      win_rate: 62.5,
    });

    const res = await GET(req('/api/public/v1/signals'));
    const body = await res.json();

    expect(body.cached).toBe(true);
    expect(countPublicSignals).not.toHaveBeenCalled();
    expect(cacheSet).not.toHaveBeenCalled();
  });

  it('cached response completes under 1 second', async () => {
    cacheGet.mockResolvedValue({
      data: [sampleRow],
      page: 1,
      total: 1,
      summary,
      win_rate: 62.5,
    });

    const t0 = Date.now();
    const res = await GET(req('/api/public/v1/signals'));
    const ms = Date.now() - t0;

    expect(res.status).toBe(200);
    expect(ms).toBeLessThan(1000);
  });

  it('stores response in cache on miss', async () => {
    await GET(req('/api/public/v1/signals?symbol=RELIANCE'));
    expect(cacheSet).toHaveBeenCalledWith(
      expect.stringContaining('public:signals'),
      expect.objectContaining({ total: 1 }),
      300,
    );
  });

  it('returns 400 for invalid date', async () => {
    const res = await GET(req('/api/public/v1/signals?from_date=not-a-date'));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
  });

  it('returns 429 when rate limited', async () => {
    const { RateLimitError } = await import('@/lib/errors');
    enforceRateLimit.mockRejectedValue(new RateLimitError());

    const res = await GET(req('/api/public/v1/signals'));
    expect(res.status).toBe(429);
  });

  it('enforces limit cap via validation path', () => {
    const q = parsePublicSignalsQuery(req('/api/public/v1/signals?limit=500'));
    expect(q.limit).toBe(100);
  });

  it('supports confidence_score sort', () => {
    const q = parsePublicSignalsQuery(req('/api/public/v1/signals?sort=confidence_score:desc'));
    expect(q.sort).toBe('confidence_score');
    expect(q.sortDir).toBe('desc');
  });
});

describe('enforcePublicSignalsAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enforceRateLimit.mockResolvedValue(undefined);
    dbQuery.mockResolvedValue({ rows: [] });
  });

  it('applies IP rate limit when no auth header', async () => {
    await enforcePublicSignalsAccess(req('/api/public/v1/signals'));
    expect(enforceRateLimit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ keyPrefix: 'public:signals' }),
    );
  });
});
