/**
 * runDailyScan({ skipIngestion: true }) must never invoke EOD ingestion.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db', () => ({
  db: {
    query: vi.fn(async (sql: string) => {
      if (/FROM candles/.test(sql)) {
        return { rows: [{ d: '2026-06-23' }] };
      }
      if (/q365_manipulation_events/.test(sql)) {
        return { rows: [{ d: '2026-06-23' }] };
      }
      return { rows: [] };
    }),
  },
}));

vi.mock('@/lib/marketData/eod/eodIngestionPipeline', () => ({
  runDailyEodIngestion: vi.fn(async () => ({
    ok: true,
    warnings: [],
    adapters: [],
  })),
}));

vi.mock('@/lib/workers/manipulationScanner', () => ({
  runManipulationScan: vi.fn(async () => ({
    scanned: 10,
    snapshotsPersisted: 10,
    skippedInsufficient: 0,
    failed: 0,
    bandCounts: { low: 8, watch: 1, elevated: 1, high: 0, severe: 0 },
    penaltiesWritten: 0,
    durationMs: 1000,
  })),
}));

import { runDailyEodIngestion } from '@/lib/marketData/eod/eodIngestionPipeline';
import { runManipulationScan } from '@/lib/workers/manipulationScanner';
import { runDailyManipulationScan } from '@/lib/manipulation-engine/pipeline/runDailyScan';

describe('runDailyScan — skipIngestion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pipeline — skipIngestion: true never calls runDailyEodIngestion', async () => {
    const result = await runDailyManipulationScan({ skipIngestion: true });

    expect(runDailyEodIngestion).not.toHaveBeenCalled();
    expect(runManipulationScan).toHaveBeenCalledTimes(1);
    expect(result.ingestion).toBeNull();
    expect(result.warnings).toContain(
      'EOD ingestion skipped by caller — scan running against existing candle warehouse.',
    );
  });

  it('pipeline — skipIngestion omitted runs ingestion then scan', async () => {
    await runDailyManipulationScan();

    expect(runDailyEodIngestion).toHaveBeenCalledTimes(1);
    expect(runManipulationScan).toHaveBeenCalledTimes(1);
  });
});
