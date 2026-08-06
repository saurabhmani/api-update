import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/db/ensureAllSchemas', () => ({
  ensureAllSchemas: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/marketData/securitiesMaster', () => ({
  importActiveEqSecuritiesFromCsv: vi.fn().mockResolvedValue({
    csvPath: '/tmp/EQUITY_L.csv',
    parsedRows: 2000,
    inserted: 2000,
    updated: 0,
    total: 2000,
    dryRun: false,
  }),
  buildSecuritiesMasterValidationSummary: vi.fn().mockResolvedValue({
    activeEqCount: 2000,
    inactiveEqCount: 0,
    source: 'EQUITY_L',
    sql: { countActiveEq: 'SELECT 1;', countInactiveEq: 'SELECT 2;', sampleActive: 'SELECT 3;' },
  }),
  logSecuritiesMasterValidation: vi.fn(),
}));

vi.mock('@/lib/marketData/candleBackfillJob', () => ({
  BACKFILL_MIN_BARS_DEFAULT: () => 240,
  BACKFILL_UNIVERSE_LIMIT_DEFAULT: () => 1000,
  runCandleBackfillJob: vi.fn().mockResolvedValue({
    totalSymbols: 50,
    universeTotal: 2000,
    alreadySufficient: 100,
    skippedSufficient: 100,
    fetched: 50,
    failed: 0,
    deferredDueToBudget: 0,
    deferred: 0,
    unsupported: 0,
    candlesInserted: 1000,
    candlesUpdated: 0,
    upstreamVendor: 50,
    upstreamRequests: 50,
    locallyBlockedRequests: 0,
    retries: 0,
    breakerTrips: 0,
    status: 'completed',
    pauseReason: null,
    resumeAfter: null,
    failures: [],
    durationMs: 100,
    dryRun: false,
  }),
}));

vi.mock('@/lib/marketData/nseUniverseChurn', () => ({
  computeUniverseChurnSelection: vi.fn().mockReturnValue({
    selected: Array.from({ length: 1000 }, (_, i) => `SYM${i}`),
    decisions: [],
    added: 1,
    kept: 999,
    removed: 0,
    targetSize: 1000,
    thresholds: { addMaxRank: 900, keepMaxRank: 1100, removeMinRank: 1200 },
  }),
  loadActiveUniverseSymbolSet: vi.fn().mockResolvedValue(new Set(['HDFCBANK'])),
}));

vi.mock('@/lib/marketData/nseUniverseRanker', () => ({
  NSE_UNIVERSE_TARGET_DEFAULT: () => 1000,
  NSE_UNIVERSE_MIN_ELIGIBLE_BARS_DEFAULT: () => 80,
  assessCandleCoverageForRanking: vi.fn().mockResolvedValue({
    eqMasterCount: 2000,
    withAnyCandles: 800,
    withMinBars: 700,
    coveragePct: 35,
    minBarsTarget: 200,
    minCoveragePct: 30,
    targetSize: 1000,
    readyForRanking: true,
    blockers: [],
    sql: { countWithMinBars: 'SELECT 1;', countActiveUniverse: 'SELECT 2;', coverageBySymbol: 'SELECT 3;' },
  }),
  logCandleCoverageValidation: vi.fn(),
  buildNseTopUniverse: vi.fn().mockResolvedValue({
    ranked: [
      { symbol: 'RELIANCE', compositeScore: 0.99, tradedValue: 1, volumeConsistency: 1, candleCompleteness: 1 },
      { symbol: 'HDFCBANK', compositeScore: 0.98, tradedValue: 1, volumeConsistency: 1, candleCompleteness: 1 },
    ],
    selected: Array.from({ length: 1000 }, (_, i) => `SYM${i}`),
    candidates: 2000,
  }),
  loadTotalDailyBarCounts: vi.fn().mockResolvedValue(new Map([
    ['RELIANCE', 200],
    ['HDFCBANK', 200],
  ])),
  applyNseUniverseSelectionToDb: vi.fn().mockResolvedValue({
    activated: 2,
    deactivated: 0,
    totalActive: 2,
    added: 1,
    kept: 1,
    removed: 0,
    sql: { countActive: 'SELECT 1;', sampleActive: 'SELECT 2;' },
  }),
  applyNseTopUniverseToDb: vi.fn().mockResolvedValue({
    activated: 1000,
    deactivated: 50,
    totalActive: 1000,
    sql: { countActive: 'SELECT 1;', sampleActive: 'SELECT 2;' },
  }),
  logUniverseApplyValidation: vi.fn(),
}));

vi.mock('@/lib/marketData/nifty500Universe', () => ({
  initNifty500UniverseFromDb: vi.fn().mockResolvedValue({ symbols: [], set: new Set(), source: 'test', loadedAt: '' }),
  getUniverseMaxSize: () => 1050,
  getUniverseMinSize: () => 950,
}));

vi.mock('@/lib/marketData/universeSnapshotRepository', () => ({
  startUniverseRebuildLog: vi.fn().mockResolvedValue(null),
  completeUniverseRebuildLog: vi.fn().mockResolvedValue(undefined),
  persistUniverseSnapshot: vi.fn().mockResolvedValue(null),
  UNIVERSE_AUDIT_SQL: { latestSnapshot: 'SELECT 1;', latestRebuild: 'SELECT 2;', churnSummary: 'SELECT 3;' },
}));

import { runWeeklyNse1000UniverseRebuild } from '@/lib/marketData/weeklyNse1000UniverseRebuild';
import { runCandleBackfillJob } from '@/lib/marketData/candleBackfillJob';
import {
  buildNseTopUniverse,
  applyNseUniverseSelectionToDb,
  applyNseTopUniverseToDb,
  loadTotalDailyBarCounts,
} from '@/lib/marketData/nseUniverseRanker';
import { importActiveEqSecuritiesFromCsv } from '@/lib/marketData/securitiesMaster';
import { computeUniverseChurnSelection, loadActiveUniverseSymbolSet } from '@/lib/marketData/nseUniverseChurn';
import { persistUniverseSnapshot, startUniverseRebuildLog } from '@/lib/marketData/universeSnapshotRepository';

describe('weeklyNse1000UniverseRebuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('runs securities import → backfill → rank → churn apply in order', async () => {
    const callOrder: string[] = [];
    vi.mocked(importActiveEqSecuritiesFromCsv).mockImplementation(async () => {
      callOrder.push('import');
      return {
        csvPath: '/tmp/EQUITY_L.csv',
        parsedRows: 2000,
        inserted: 2000,
        updated: 0,
        total: 2000,
        dryRun: false,
      };
    });
    vi.mocked(runCandleBackfillJob).mockImplementation(async () => {
      callOrder.push('backfill');
      return {
        totalSymbols: 50,
        universeTotal: 2000,
        alreadySufficient: 100,
        skippedSufficient: 0,
        fetched: 50,
        failed: 0,
        deferredDueToBudget: 0,
        deferred: 0,
        unsupported: 0,
        candlesInserted: 1000,
        candlesUpdated: 0,
        upstreamVendor: 50,
        upstreamRequests: 50,
        locallyBlockedRequests: 0,
        retries: 0,
        breakerTrips: 0,
        status: 'completed' as const,
        pauseReason: null,
        resumeAfter: null,
        failures: [],
        durationMs: 100,
        dryRun: false,
      };
    });
    vi.mocked(buildNseTopUniverse).mockImplementation(async () => {
      callOrder.push('rank');
      return {
        ranked: [{ symbol: 'RELIANCE', compositeScore: 0.99, tradedValue: 1, volumeConsistency: 1, candleCompleteness: 1 }],
        selected: Array.from({ length: 1000 }, (_, i) => `SYM${i}`),
        candidates: 2000,
      };
    });
    vi.mocked(computeUniverseChurnSelection).mockImplementation(() => {
      callOrder.push('churn');
      return {
        selected: Array.from({ length: 1000 }, (_, i) => `SYM${i}`),
        decisions: [],
        added: 0,
        kept: 1000,
        removed: 0,
        targetSize: 1000,
        thresholds: { addMaxRank: 900, keepMaxRank: 1100, removeMinRank: 1200 },
      };
    });
    vi.mocked(applyNseUniverseSelectionToDb).mockImplementation(async () => {
      callOrder.push('apply');
      return {
        activated: 1,
        deactivated: 0,
        totalActive: 1,
        added: 0,
        kept: 1,
        removed: 0,
        sql: { countActive: 'SELECT 1;', sampleActive: 'SELECT 2;' },
      };
    });

    const summary = await runWeeklyNse1000UniverseRebuild({ targetSize: 1000 });

    expect(callOrder).toEqual(['import', 'backfill', 'rank', 'churn', 'apply']);
    expect(summary.ok).toBe(true);
    expect(summary.churn?.selected.length).toBe(1000);
    expect(loadActiveUniverseSymbolSet).toHaveBeenCalled();
    expect(loadTotalDailyBarCounts).toHaveBeenCalled();
    expect(startUniverseRebuildLog).toHaveBeenCalled();
    expect(persistUniverseSnapshot).toHaveBeenCalled();
    expect(runCandleBackfillJob).toHaveBeenCalledWith(
      expect.objectContaining({ symbolSource: 'securities_master', resume: true }),
    );
  });

  it('uses bootstrap top-N path when churn control is disabled', async () => {
    await runWeeklyNse1000UniverseRebuild({ targetSize: 1000, useChurnControl: false });

    expect(computeUniverseChurnSelection).not.toHaveBeenCalled();
    expect(applyNseTopUniverseToDb).toHaveBeenCalled();
    expect(applyNseUniverseSelectionToDb).not.toHaveBeenCalled();
  });

  it('skips ranking when candle coverage is insufficient', async () => {
    const { assessCandleCoverageForRanking } = await import('@/lib/marketData/nseUniverseRanker');
    vi.mocked(assessCandleCoverageForRanking).mockResolvedValueOnce({
      eqMasterCount: 2000,
      withAnyCandles: 0,
      withMinBars: 0,
      coveragePct: 0,
      minBarsTarget: 200,
      minCoveragePct: 30,
      targetSize: 1000,
      readyForRanking: false,
      blockers: ['no EQ symbols have candle data — run candle backfill first'],
      sql: { countWithMinBars: 'SELECT 1;', countActiveUniverse: 'SELECT 2;', coverageBySymbol: 'SELECT 3;' },
    });

    const summary = await runWeeklyNse1000UniverseRebuild({ skipBackfill: true });

    expect(buildNseTopUniverse).not.toHaveBeenCalled();
    expect(applyNseUniverseSelectionToDb).not.toHaveBeenCalled();
    expect(summary.ok).toBe(false);
    expect(summary.blockers.length).toBeGreaterThan(0);
  });
});
