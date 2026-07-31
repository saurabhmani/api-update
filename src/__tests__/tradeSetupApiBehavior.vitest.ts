import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  dbQuery: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
  cacheDelete: vi.fn(),
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
  resolvePrice: vi.fn(),
  generateSignal: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ requireSession: mocks.requireSession }));
vi.mock('@/lib/db', () => ({ db: { query: mocks.dbQuery } }));
vi.mock('@/lib/db/ensureAllSchemas', () => ({
  ensureAllSchemas: vi.fn(async () => ({ created: 0, failed: 0, cached: true })),
}));
vi.mock('@/lib/cache/cacheService', () => ({
  cacheService: {
    get: mocks.cacheGet,
    set: mocks.cacheSet,
    delete: mocks.cacheDelete,
  },
}));
vi.mock('@/lib/redis', () => ({
  cacheAcquireDistributedLock: mocks.acquireLock,
  cacheReleaseLock: mocks.releaseLock,
}));
vi.mock('@/lib/marketData/resolver/marketDataResolver', () => ({
  resolvePrice: mocks.resolvePrice,
}));
vi.mock('@/lib/signal-engine/live/analyzeInstrument', () => ({
  generateSignal: mocks.generateSignal,
}));
vi.mock('@/lib/strategy-hub/registry', () => ({
  getRegistryEntry: vi.fn(() => ({ version: 'test' })),
}));
vi.mock('@/lib/marketData/marketHours', () => ({
  getLatestCompletedTradingDay: () => '2026-07-30',
  getMarketStatus: () => ({ state: 'closed', isOpen: false }),
}));

import { GET, POST } from '@/app/api/trade-setups/route';

function request(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/trade-setups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(): NextRequest {
  return new NextRequest('http://localhost/api/trade-setups?limit=20');
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'RELIANCE',
    strategyId: 'auto',
    timeframe: 'swing',
    ...overrides,
  };
}

const signal = {
  tradingsymbol: 'RELIANCE',
  exchange: 'NSE',
  direction: 'BUY',
  entry_price: 100,
  stop_loss: 95,
  target1: 110,
  target2: 115,
  risk_reward: 2,
  confidence: 80,
  timeframe: 'swing',
  reasons: [{ text: 'Test reason' }],
  rejection_reasons: [],
  scenario_tag: 'breakout',
  regime: 'bullish',
  strategy: 'trend',
};

describe('trade setup API behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ id: 'user-a' });
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue(undefined);
    mocks.cacheDelete.mockResolvedValue(undefined);
    mocks.acquireLock.mockResolvedValue('acquired');
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.resolvePrice.mockResolvedValue({
      price: 100,
      source: 'resolver-test',
      quality: 'HIGH',
    });
    mocks.generateSignal.mockResolvedValue(signal);
    mocks.dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM rankings WHERE')) {
        return {
          rows: [{
            instrument_key: 'NSE_EQ|RELIANCE',
            tradingsymbol: 'RELIANCE',
            exchange: 'NSE',
          }],
        };
      }
      if (sql.includes('MAX(ts)')) return { rows: [{ latest: '2026-07-30T10:00:00Z' }] };
      if (sql.includes('FROM trade_setups') && sql.includes('generation_identity')) {
        return { rows: [] };
      }
      return { rows: [], affectedRows: 1 };
    });
  });

  it('rejects invalid input before database or provider work', async () => {
    const response = await POST(request(validBody({ timeframe: '1m' })));
    expect(response.status).toBe(400);
    expect(mocks.dbQuery).not.toHaveBeenCalled();
    expect(mocks.resolvePrice).not.toHaveBeenCalled();
  });

  it('preserves the authenticated active-list response contract', async () => {
    mocks.dbQuery.mockResolvedValueOnce({ rows: [signal] });
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ setups: [signal], count: 1 });
  });

  it('keeps authentication enforced', async () => {
    mocks.requireSession.mockRejectedValueOnce(new Error('Unauthorized'));
    const response = await POST(request(validBody()));
    expect(response.status).toBe(401);
    expect(mocks.dbQuery).not.toHaveBeenCalled();
  });

  it('keeps symbol ownership authorization enforced', async () => {
    mocks.dbQuery.mockResolvedValue({ rows: [] });
    const response = await POST(request(validBody()));
    expect(response.status).toBe(403);
    expect(mocks.resolvePrice).not.toHaveBeenCalled();
  });

  it('serves a user-scoped cache hit without provider or persistence work', async () => {
    mocks.cacheGet.mockResolvedValueOnce({
      success: true,
      setup: signal,
      setups: [signal],
      generationStatus: 'complete',
      note: 'cached',
    });
    const response = await POST(request(validBody()));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache')).toBe('HIT');
    expect(mocks.resolvePrice).not.toHaveBeenCalled();
    expect(mocks.generateSignal).not.toHaveBeenCalled();
    expect(mocks.dbQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO trade_setups')))
      .toBe(false);
  });

  it('loads, persists idempotently, and caches on a miss', async () => {
    const response = await POST(request(validBody()));
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Cache')).toBe('MISS');
    expect(mocks.resolvePrice).toHaveBeenCalledWith('RELIANCE');
    expect(mocks.generateSignal).toHaveBeenCalledTimes(1);
    expect(mocks.dbQuery.mock.calls.some(([sql]) => (
      String(sql).includes('ON DUPLICATE KEY UPDATE')
    ))).toBe(true);
    expect(mocks.cacheSet).toHaveBeenCalledTimes(1);
  });

  it('manual regeneration invalidates and bypasses the cached result', async () => {
    const response = await POST(request(validBody({ force: true })));
    expect(response.status).toBe(200);
    expect(mocks.cacheDelete).toHaveBeenCalledTimes(1);
    expect(mocks.cacheGet).toHaveBeenCalledTimes(0);
    expect(mocks.resolvePrice).toHaveBeenCalledTimes(1);
  });

  it('returns in-progress when the distributed lock is held', async () => {
    mocks.acquireLock.mockResolvedValueOnce('held');
    const response = await POST(request(validBody()));
    expect(response.status).toBe(202);
    expect(mocks.resolvePrice).not.toHaveBeenCalled();
    expect(response.headers.get('Retry-After')).toBe('2');
  });

  it('coalesces duplicate concurrent requests into one generation', async () => {
    let resolveProvider!: (value: unknown) => void;
    mocks.resolvePrice.mockImplementationOnce(() => new Promise((resolve) => {
      resolveProvider = resolve;
    }));
    const first = POST(request(validBody()));
    await vi.waitFor(() => expect(mocks.resolvePrice).toHaveBeenCalledTimes(1));
    const second = POST(request(validBody()));
    await vi.waitFor(() => expect(mocks.cacheGet.mock.calls.length).toBeGreaterThanOrEqual(3));
    resolveProvider({ price: 100, source: 'resolver-test', quality: 'HIGH' });
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(mocks.resolvePrice).toHaveBeenCalledTimes(1);
    expect(secondResponse.headers.get('X-Request-Coalesced')).toBe('true');
  });

  it('continues with in-process coalescing when Redis locking is unavailable', async () => {
    mocks.acquireLock.mockResolvedValueOnce('unavailable');
    const response = await POST(request(validBody()));
    expect(response.status).toBe(200);
    expect(mocks.resolvePrice).toHaveBeenCalledTimes(1);
    expect(mocks.releaseLock).not.toHaveBeenCalled();
  });

  it('returns a sanitized provider failure', async () => {
    mocks.resolvePrice.mockRejectedValueOnce(new Error('provider-token=secret'));
    const response = await POST(request(validBody()));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain('Trade setup generation failed safely');
    expect(body).not.toContain('provider-token=secret');
  });

  it('returns a sanitized database failure', async () => {
    mocks.dbQuery.mockRejectedValueOnce(new Error('mysql password secret'));
    const response = await POST(request(validBody()));
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('mysql password secret');
  });

  it('uses different cache identities for different authenticated users', async () => {
    await POST(request(validBody()));
    const userAKey = mocks.cacheGet.mock.calls[0]?.[0];
    vi.clearAllMocks();
    mocks.requireSession.mockResolvedValue({ id: 'user-b' });
    mocks.cacheGet.mockResolvedValue(null);
    mocks.cacheSet.mockResolvedValue(undefined);
    mocks.acquireLock.mockResolvedValue('acquired');
    mocks.releaseLock.mockResolvedValue(undefined);
    mocks.resolvePrice.mockResolvedValue({ price: 100, source: 'resolver-test', quality: 'HIGH' });
    mocks.generateSignal.mockResolvedValue(signal);
    mocks.dbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM rankings WHERE')) {
        return { rows: [{ instrument_key: 'NSE_EQ|RELIANCE', tradingsymbol: 'RELIANCE', exchange: 'NSE' }] };
      }
      if (sql.includes('MAX(ts)')) return { rows: [{ latest: '2026-07-30T10:00:00Z' }] };
      return { rows: [] };
    });
    await POST(request(validBody()));
    const userBKey = mocks.cacheGet.mock.calls[0]?.[0];
    expect(userAKey).not.toBe(userBKey);
    expect(String(userAKey)).not.toContain('user-a');
    expect(String(userBKey)).not.toContain('user-b');
  });
});
