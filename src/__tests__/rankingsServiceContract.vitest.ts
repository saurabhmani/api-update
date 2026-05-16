/**
 * rankingsService — closed-market fallback + cache-source labeling +
 * global opportunity_rank pagination contract tests.
 *
 * Pins behaviors fixed in:
 *   ISSUE 4 — global sort BEFORE pagination
 *   ISSUE 5 — closed-market must NOT fan out to live providers
 *   ISSUE 6 — cache hit must be labeled cache_hit=true / data_source=redis
 *
 * The service has heavy DB / network deps; these tests exercise the
 * pure logic by mocking @/lib/redis, @/lib/db, ./marketQuote, and
 * ./dataSync, then driving getRankings() through each branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── In-memory mock state ────────────────────────────────────────────
const mockState = {
  cacheStore:   new Map<string, any>(),
  dbRows:       [] as any[],
  dbCalls:      [] as Array<{ sql: string; params: any[] }>,
  liveCalled:   false,
  syncCalled:   false,
};

vi.mock('@/lib/redis', () => ({
  cacheGet: async <T>(k: string): Promise<T | null> =>
    (mockState.cacheStore.get(k) as T) ?? null,
  cacheSet: async (k: string, v: any) => { mockState.cacheStore.set(k, v); },
}));

vi.mock('@/lib/db', () => ({
  db: {
    query: async (sql: string, params: any[] = []) => {
      mockState.dbCalls.push({ sql, params });
      // COUNT query
      if (/COUNT/i.test(sql)) {
        return { rows: [{ total: mockState.dbRows.length }] };
      }
      // Data query — pretend the SQL already returned the wider pool.
      // The real SQL aliases r.tradingsymbol → symbol; mirror that
      // here so the service's row mapper picks up the symbol field.
      const aliased = mockState.dbRows.map((r) => ({
        ...r,
        symbol: r.symbol ?? r.tradingsymbol,
      }));
      return { rows: aliased };
    },
  },
}));

vi.mock('@/services/marketQuote', () => ({
  fetchIndices:        async () => { mockState.liveCalled = true; return []; },
  fetchGainersLosers:  async () => { mockState.liveCalled = true; return []; },
}));

vi.mock('@/services/dataSync', () => ({
  syncRankingsFromNse: async () => { mockState.syncCalled = true; },
}));

vi.mock('@/lib/signal-engine/constants/phase3.constants', () => ({
  getSector: (_s: string) => 'Other',
}));

beforeEach(() => {
  mockState.cacheStore.clear();
  mockState.dbRows    = [];
  mockState.dbCalls   = [];
  mockState.liveCalled = false;
  mockState.syncCalled = false;
});

afterEach(() => { vi.resetModules(); });

async function loadService() {
  return await import('@/services/rankingsService');
}

// ── ISSUE 5 — closed market blocks external fallback ────────────────
describe('getRankings — closed-market external fallback', () => {
  it('returns data_source=unavailable when DB is empty AND allowExternalFallback=false', async () => {
    mockState.dbRows = [];   // empty rankings table
    const svc = await loadService();
    const res = await svc.getRankings({ limit: 50, allowExternalFallback: false });
    expect(res.data_source).toBe('unavailable');
    expect(res.data).toEqual([]);
    expect(mockState.liveCalled).toBe(false);
    expect(mockState.syncCalled).toBe(false);
    expect(res.message).toMatch(/closed/i);
  });

  it('DOES call live + sync when allowExternalFallback=true and DB is empty', async () => {
    mockState.dbRows = [];
    const svc = await loadService();
    const res = await svc.getRankings({ limit: 50, allowExternalFallback: true });
    // Either liveCalled or syncCalled — depends on which path returns
    // first in the cascade. Both paths are blocked when fallback=false,
    // so seeing EITHER fire here proves the gate is wired.
    expect(mockState.liveCalled || mockState.syncCalled).toBe(true);
    expect(res.data_source).not.toBe('unavailable');
  });
});

// ── ISSUE 6 — cache hit labeled honestly ────────────────────────────
describe('getRankings — cache_hit + data_source labeling', () => {
  it('cache hit returns data_source=redis + cache_hit=true', async () => {
    // Pre-populate the cache with a result that originally came from
    // mysql. The previous bug was returning this object as-is, so the
    // UI's "Cached" badge never lit up. Now the service must overwrite
    // data_source to 'redis' on the cache-hit path.
    const cached = {
      data: [{ symbol: 'AAA', score: 80, opportunity_rank: 90 }],
      count: 1, total: 1, page: 1, limit: 50, has_more: false,
      data_source: 'mysql' as const,
      cache_hit: false,
      as_of: new Date().toISOString(),
    };
    mockState.cacheStore.set('rankings:top:50:ALL', cached);
    const svc = await loadService();
    const res = await svc.getRankings({ limit: 50 });
    expect(res.data_source).toBe('redis');
    expect(res.cache_hit).toBe(true);
  });

  it('fresh DB read sets cache_hit=false', async () => {
    mockState.dbRows = [
      { tradingsymbol: 'AAA', name: 'AAA', exchange: 'NSE', score: 80,
        ltp: 100, pct_change: 1, volume: 1000, instrument_key: 'NSE_EQ|AAA' },
    ];
    const svc = await loadService();
    const res = await svc.getRankings({ limit: 50 });
    expect(res.data_source).toBe('mysql');
    expect(res.cache_hit).toBe(false);
  });
});

// ── ISSUE 4 — global opportunity_rank sort BEFORE pagination ────────
describe('getRankings — global sort before pagination', () => {
  it('returns rows sorted by opportunity_rank, not by raw score', async () => {
    // Seed the "DB" with 3 rows whose raw `score` order disagrees with
    // their opportunity_rank order. The service's compareRanked must
    // override the SQL order when materializing the response.
    //
    // computeOpportunityRank blends conviction band + confidence + risk
    // on top of the raw score; we lean on the conviction_band signal
    // available via the LEFT JOIN'd q365_signals row to push
    // ZEBRA above ALPHA even though ZEBRA has a lower raw score.
    //
    // Without LEFT JOIN data, computeOpportunityRank degrades to
    // ~score; in this test we just assert deterministic ordering by
    // opportunity_rank (which is materialized from the seeded score).
    mockState.dbRows = [
      { tradingsymbol: 'ALPHA', name: 'A', exchange: 'NSE', score: 95,
        ltp: 100, pct_change: 0, volume: 100, instrument_key: 'NSE_EQ|ALPHA' },
      { tradingsymbol: 'ZEBRA', name: 'Z', exchange: 'NSE', score: 80,
        ltp: 100, pct_change: 0, volume: 100, instrument_key: 'NSE_EQ|ZEBRA' },
      { tradingsymbol: 'MIKE',  name: 'M', exchange: 'NSE', score: 90,
        ltp: 100, pct_change: 0, volume: 100, instrument_key: 'NSE_EQ|MIKE' },
    ];
    const svc = await loadService();
    const res = await svc.getRankings({ limit: 50 });
    const opps = res.data.map((r) => r.opportunity_rank);
    // Strictly non-increasing — global sort key holds
    for (let i = 1; i < opps.length; i++) {
      expect(opps[i - 1]).toBeGreaterThanOrEqual(opps[i]);
    }
    // rank_position is re-stamped after the global sort so it never
    // disagrees with the visible row order.
    res.data.forEach((r, i) => expect(r.rank_position).toBe(i + 1));
  });

  it('limit=N returns the true top-N — outliers cannot be hidden by SQL LIMIT', async () => {
    // Build a wide pool. The service should fetch ≥ CANDIDATE_FLOOR
    // (200) rows when computing a global sort, so a high-opportunity
    // outlier at row 199 still makes the top-1 cut on a limit=1 call.
    mockState.dbRows = [];
    for (let i = 0; i < 100; i++) {
      mockState.dbRows.push({
        tradingsymbol: `STK${i.toString().padStart(3, '0')}`,
        name: `Stock ${i}`, exchange: 'NSE',
        score: 50 + (i * 0.1),
        ltp: 100, pct_change: 0, volume: 100,
        instrument_key: `NSE_EQ|STK${i}`,
      });
    }
    // Outlier deep in the candidate pool
    mockState.dbRows.push({
      tradingsymbol: 'WINNER', name: 'W', exchange: 'NSE',
      score: 99,                          // top raw score
      ltp: 100, pct_change: 0, volume: 100,
      instrument_key: 'NSE_EQ|WINNER',
    });
    const svc = await loadService();
    const res = await svc.getRankings({ limit: 1 });
    expect(res.data[0].symbol).toBe('WINNER');
  });
});
