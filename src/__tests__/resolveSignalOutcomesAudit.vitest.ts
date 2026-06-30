/**
 * Production audit — resolveSignalOutcomes separation & idempotency guards.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const dbQuery = vi.fn();

vi.mock('@/lib/db', () => ({
  db: { query: (...args: unknown[]) => dbQuery(...args) },
}));

vi.mock('@/lib/db/migrateSignalOutcomesPublic', () => ({
  migrateSignalOutcomesPublic: vi.fn(async () => {}),
}));

vi.mock('@/lib/marketData/candleFallbackChain', () => ({
  fetchDailyCandlesWithFallback: vi.fn(async () => ({ candles: [] })),
}));

import { fetchPendingSignals, fetchActiveOutcomeSignals } from '@/lib/signals/outcome/resolveSignalOutcomes';

describe('resolveSignalOutcomes audit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbQuery.mockResolvedValue({ rows: [] });
  });

  it('fetchPendingSignals only selects signals without outcome rows', async () => {
    await fetchPendingSignals(100);
    const [sql] = dbQuery.mock.calls[0] as [string];
    expect(sql).toContain('o.signal_id IS NULL');
    expect(sql).not.toContain("o.outcome = 'ACTIVE'");
  });

  it('fetchActiveOutcomeSignals only selects ACTIVE ledger rows', async () => {
    await fetchActiveOutcomeSignals(50);
    const [sql] = dbQuery.mock.calls[0] as [string];
    expect(sql).toContain("o.outcome = 'ACTIVE'");
  });
});
