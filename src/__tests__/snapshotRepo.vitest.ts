// ════════════════════════════════════════════════════════════════
//  snapshotRepo UPSERT + read — pg is mocked so we don't need a DB.
//
//  We assert the SQL shape (ON CONFLICT / UPSERT, RETURNING, etc.)
//  and the round-trip between UpsertSnapshotInput and MarketSnapshot.
// ════════════════════════════════════════════════════════════════

import { describe, expect, it, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db/postgres', () => ({
  pg: {
    query: (...args: unknown[]) => queryMock(...args),
    tx: async <T,>(fn: (c: { query: (s: string, p?: unknown[]) => Promise<unknown> }) => Promise<T>) =>
      fn({ query: queryMock }),
    healthCheck: async () => ({ ok: true, latencyMs: 1 }),
    close: async () => undefined,
  },
}));

import { upsertSnapshot, upsertSnapshotBatch, getSnapshot } from '@/services/repos/snapshotRepo';
import type { ProviderSource } from '@/types/market';

function input(symbol: string, price: number): Parameters<typeof upsertSnapshot>[0] {
  return {
    symbol, price, ltp: price,
    change: 1, changePercent: 0.5,
    volume: 1000, open: price - 1, high: price + 1, low: price - 2, prevClose: price - 1,
    timestamp: 1_700_000_000_000,
    source: 'indian' as ProviderSource,
    dataQuality: 'near-live',
  };
}

describe('snapshotRepo', () => {
  beforeEach(() => { queryMock.mockReset(); });

  it('upsertSnapshot issues ON CONFLICT DO UPDATE with all columns', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    await upsertSnapshot(input('RELIANCE', 2500));

    expect(queryMock).toHaveBeenCalledOnce();
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO market\.snapshots_current/);
    expect(sql).toMatch(/ON CONFLICT \(symbol\) DO UPDATE SET/);
    expect(sql).toMatch(/to_timestamp\(\$12 \/ 1000\.0\)/);
    // 12 positional params (columns + ts)
    expect(params).toHaveLength(12);
    expect(params[0]).toBe('RELIANCE');
    expect(params[1]).toBe(2500);
    expect(params[11]).toBe(1_700_000_000_000);
  });

  it('upsertSnapshotBatch uses UNNEST for a single round-trip', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const written = await upsertSnapshotBatch([input('A', 10), input('B', 20)]);
    expect(written).toBe(2);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/UNNEST\(/);
    expect(sql).toMatch(/ON CONFLICT \(symbol\) DO UPDATE SET/);
    // 12 array parameters, each of length 2
    expect(params).toHaveLength(12);
    expect((params[0] as string[]).length).toBe(2);
  });

  it('batch with zero rows returns 0 and makes no call', async () => {
    const n = await upsertSnapshotBatch([]);
    expect(n).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('getSnapshot maps row fields → MarketSnapshot', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        symbol: 'TCS',
        price: '4000.50', prev_close: '3980.00', change: '20.50', change_percent: '0.51',
        open: '3990', high: '4010', low: '3985', volume: '123456',
        source: 'kite', data_quality: 'live',
        fetched_at: new Date(1_700_000_000_000),
      }],
    });
    const snap = await getSnapshot('TCS');
    expect(snap).not.toBeNull();
    expect(snap!.symbol).toBe('TCS');
    expect(snap!.price).toBe(4000.5);
    expect(snap!.prevClose).toBe(3980);
    expect(snap!.timestamp).toBe(1_700_000_000_000);
  });

  it('getSnapshot returns null when no row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const snap = await getSnapshot('UNKNOWN');
    expect(snap).toBeNull();
  });
});
