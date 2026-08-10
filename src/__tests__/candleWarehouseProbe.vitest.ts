import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  probeCandleWarehouse,
  resetCandleWarehouseProbeCache,
} from '@/lib/monitor/candleWarehouseProbe';

const queryMock = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    query: (...args: unknown[]) => queryMock(...args),
  },
}));

vi.mock('@/lib/engineDebug/engineDebugger', () => ({
  getEngineDebugContext: () => undefined,
  engineDebugger: {
    dbStart: () => ({ end: () => {}, error: () => {} }),
  },
}));

describe('probeCandleWarehouse', () => {
  beforeEach(() => {
    resetCandleWarehouseProbeCache();
    queryMock.mockReset();
  });

  it('uses MAX(ts) only — never COUNT(*) / COUNT(DISTINCT)', async () => {
    queryMock.mockResolvedValue({
      rows: [{ latest: '2026-08-08T00:00:00.000Z' }],
    });
    const cov = await probeCandleWarehouse();
    expect(cov.latestCandleDate).toBe('2026-08-08');
    expect(cov.candleCount).toBe(1);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/MAX\s*\(\s*ts\s*\)/i);
    expect(sql).not.toMatch(/COUNT\s*\(/i);
    expect(sql).not.toMatch(/DISTINCT/i);
  });

  it('coalesces concurrent callers into one query', async () => {
    let resolveQuery!: (v: unknown) => void;
    queryMock.mockReturnValue(
      new Promise((resolve) => {
        resolveQuery = resolve;
      }),
    );
    const p1 = probeCandleWarehouse();
    const p2 = probeCandleWarehouse();
    resolveQuery({ rows: [{ latest: '2026-08-08' }] });
    const [a, b] = await Promise.all([p1, p2]);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(a.latestCandleDate).toBe('2026-08-08');
    expect(b.latestCandleDate).toBe('2026-08-08');
  });

  it('serves TTL cache on subsequent calls', async () => {
    queryMock.mockResolvedValue({ rows: [{ latest: '2026-08-08' }] });
    await probeCandleWarehouse();
    const second = await probeCandleWarehouse();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(second.fromCache).toBe(true);
  });
});
