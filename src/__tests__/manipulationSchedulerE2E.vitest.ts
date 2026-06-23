/**
 * E2E validation — scheduler integration → scan → manipulationRiskMeta → health.
 *
 * Simulates the post-18:30 IST daily scan cycle:
 *   runManipulationDailyScanJob → runDailyScan({ skipIngestion: true })
 *   → snapshots in DB → fetchManipulationRiskForSignalPools → buildManipulationHealthNode
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { DailyScanResult } from '@/lib/manipulation-engine/pipeline/runDailyScan';
import type { ManipulationRisk } from '@/lib/manipulation-engine/manipulationSignalRisk';
import type { ManipulationRiskMeta } from '@/lib/signals/manipulationRiskFetch';
import type { EngineHealthContext } from '@/lib/signals/engineHealthMap';

const scheduledJobs: Array<{ cron: string; fn: () => void }> = [];

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((cronExpr: string, fn: () => void) => {
      scheduledJobs.push({ cron: cronExpr, fn });
      return { stop: vi.fn() };
    }),
  },
}));

vi.mock('@/lib/manipulation-engine/pipeline/runDailyScan', () => ({
  runDailyScan: vi.fn(),
}));

vi.mock('@/lib/marketData/candleDailyUpdateJob', () => ({
  runCandleDailyUpdateJob: vi.fn(),
}));
vi.mock('@/lib/marketData/candleFallbackChain', () => ({
  fetchDailyCandlesWithFallback: vi.fn(),
  resetCandleSourceCounters: vi.fn(),
  getIndianApiCandleRequestCount: vi.fn(() => 0),
}));
vi.mock('@/lib/marketData/eod/eodIngestionPipeline', () => ({
  runDailyEodIngestion: vi.fn(),
}));
vi.mock('@/lib/signal-engine', () => ({
  generatePhase4Signals: vi.fn(),
  DEFAULT_PHASE3_CONFIG: { defaultCapital: 1_000_000 },
}));
vi.mock('@/lib/signal-engine/constants/signalEngine.constants', () => ({
  DEFAULT_PHASE1_CONFIG: { universe: [] },
  loadTradeableUniverse: vi.fn(async () => []),
}));
vi.mock('@/lib/startup/ensureUniverseReady', () => ({
  ensureUniverseReady: vi.fn(async () => ({ ok: true, error: null })),
}));
vi.mock('@/lib/marketData/providers/batchScheduler', () => ({
  markPipelineHeartbeat: vi.fn(),
}));
vi.mock('@/lib/marketData/providerRequestPolicy', () => ({
  DAILY_UPDATE_MAX_REQUESTS: () => 50,
}));

const computeManipulationFreshness = vi.fn();

vi.mock('@/lib/manipulation-engine/manipulationSignalRisk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manipulation-engine/manipulationSignalRisk')>();
  return {
    ...actual,
    computeManipulationFreshness: (...args: unknown[]) => computeManipulationFreshness(...args),
  };
});

import { runDailyScan } from '@/lib/manipulation-engine/pipeline/runDailyScan';
import {
  runManipulationDailyScanJob,
  startDailyScanSchedule,
  stopDailyScanSchedule,
} from '@/lib/workers/dailyScanSchedule';
import {
  fetchManipulationRiskForSignalPools,
  buildManipulationRiskMeta,
  MANIPULATION_FALLBACK_SAMPLE_SIZE,
} from '@/lib/signals/manipulationRiskFetch';
import {
  buildManipulationHealthNode,
  buildEngineHealthMap,
} from '@/lib/signals/engineHealthMap';

const FRESH_AT = '2026-06-23T13:41:10.000Z';
const STALE_AT = '2026-06-01T10:00:00.000Z';
const MANIPULATION_CRON = '30 18 * * 1-5';

const scanSuccess = (persisted = 478): DailyScanResult => ({
  ok: true,
  startedAt: '2026-06-23T13:00:00.000Z',
  completedAt: '2026-06-23T13:05:00.000Z',
  candlesAdvanced: false,
  candleDateBefore: '2026-06-23',
  candleDateAfter: '2026-06-23',
  ingestion: null,
  scan: {
    skipped: false,
    scanned: 502,
    snapshotsPersisted: persisted,
    skippedInsufficient: 24,
    failed: 0,
    bandCounts: { low: 439, watch: 13, elevated: 20, high: 6, severe: 0 },
    penaltiesWritten: 0,
    durationMs: 18_000,
  },
  latestEventDate: '2026-06-23',
  reason: 'Scanner ran without ingestion.',
  warnings: ['EOD ingestion skipped by caller — scan running against existing candle warehouse.'],
});

const freshRisk = (): ManipulationRisk => ({
  score: 12,
  band: 'LOW',
  freshnessStatus: 'FRESH',
  latestEventDate: '2026-06-20',
  latestScanAt: FRESH_AT,
  dominantPatterns: [],
  alertCount: 0,
  criticalCount: 0,
  recommendedAction: 'NO_IMPACT',
  canAffectApproval: false,
  explanation: '',
  evidence: [],
});

const staleRisk = (): ManipulationRisk => ({
  ...freshRisk(),
  freshnessStatus: 'STALE',
  latestScanAt: STALE_AT,
});

const noSnapshotRisk = (): ManipulationRisk => ({
  score: null,
  band: 'UNKNOWN',
  freshnessStatus: 'NO_DATA',
  latestEventDate: null,
  latestScanAt: null,
  dominantPatterns: [],
  alertCount: 0,
  criticalCount: 0,
  recommendedAction: 'NO_IMPACT',
  canAffectApproval: false,
  explanation: '',
  evidence: [],
});

const baseHealthCtx = (meta: ManipulationRiskMeta): EngineHealthContext => ({
  generatedAt: new Date().toISOString(),
  marketStatus: { isOpen: true, label: 'Market Open', state: 'open' },
  feed: {
    provider: 'indianapi',
    lastSuccessAt: new Date().toISOString(),
    lastApiRequestAt: new Date().toISOString(),
    isBootstrap: false,
    isFallback: false,
    staleMinutes: 10,
    freshnessLabel: 'fresh',
    coveragePercent: null,
    symbolsRequested: null,
    symbolsReturned: null,
    candleAgeHours: 1,
  },
  transport: {
    signalsAvailable: true,
    signalsTimedOut: false,
    signalsErrorMessage: null,
    dailyReportAvailable: false,
    backtestAvailable: false,
  },
  pipeline: {
    lastPipelineRunAt: new Date().toISOString(),
    lastConfirmedSignalAt: null,
    latestBatchId: 'batch-1',
    latestBatchEngineKind: 'phase4',
    scanCoveragePercent: 12,
    totalScanned: 50,
    totalPersisted: 50,
    universeSize: 502,
    inProgressCount: 0,
    validationStatus: 'ok',
  },
  signals: {
    approved: [],
    highPotential: [],
    watchlist: [],
    developing: [],
    scannerCandidates: [],
    riskRestricted: [],
    rejected: [],
  },
  counters: {
    approvedTotal: 0,
    approvedBuy: 0,
    approvedSell: 0,
    highPotentialTotal: 0,
    watchlistTotal: 0,
    rejectedTotal: 0,
    candidateTotal: 0,
  },
  dueDiligenceSummary: null,
  manipulationRiskMeta: meta,
});

const emptyPools = () => ({
  finalRows: [] as Array<{ symbol?: string }>,
  belowFloorDemoted: [] as Array<{ symbol?: string }>,
  inProgressEnriched: [] as Array<{ symbol?: string }>,
});

const universe = Array.from({ length: 25 }, (_, i) => `SYM${i + 1}`);

describe('manipulation scheduler E2E — scan → meta → health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scheduledJobs.length = 0;
    stopDailyScanSchedule();
    process.env.DAILY_SCAN_SCHEDULE_ENABLED = 'true';
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    stopDailyScanSchedule();
    vi.restoreAllMocks();
  });

  it('E2E.1 — scheduler cron invokes runDailyScan({ skipIngestion: true })', async () => {
    vi.mocked(runDailyScan).mockResolvedValue(scanSuccess());

    startDailyScanSchedule();
    const job = scheduledJobs.find((j) => j.cron === MANIPULATION_CRON);
    expect(job).toBeDefined();

    job!.fn();
    await vi.waitFor(() => expect(runDailyScan).toHaveBeenCalled());

    expect(runDailyScan).toHaveBeenCalledWith({ skipIngestion: true });
  });

  it('E2E.2 — runManipulationDailyScanJob persists snapshots (snapshotsPersisted > 0)', async () => {
    vi.mocked(runDailyScan).mockResolvedValue(scanSuccess(478));

    const result = await runManipulationDailyScanJob();

    expect(result.scan.snapshotsPersisted).toBeGreaterThan(0);
    expect(result.ingestion).toBeNull();
    expect(runDailyScan).toHaveBeenCalledWith({ skipIngestion: true });
  });

  it('E2E.3 — post-scan fetch populates manipulationRiskMeta with fresh global probe', async () => {
    computeManipulationFreshness.mockResolvedValue({
      latestEventDate: '2026-06-23',
      latestCandleDate: '2026-06-23',
      latestScanAt: FRESH_AT,
      latestTradingDate: '2026-06-23',
      isStale: false,
      daysLag: 0,
      status: 'FRESH',
      reason: 'ok',
      snapshotsPersisted30d: 478,
    });

    const fetch = await fetchManipulationRiskForSignalPools(
      emptyPools(),
      universe,
      async (symbols) => new Map(symbols.map((s) => [s.toUpperCase(), freshRisk()])),
    );

    expect(fetch.manipulationRiskMeta.configured).toBe(true);
    expect(fetch.manipulationRiskMeta.snapshotCount).toBeGreaterThan(0);
    expect(fetch.manipulationRiskMeta.globalSnapshotCount).toBe(478);
    expect(fetch.manipulationRiskMeta.freshestSnapshotAt).toBe(FRESH_AT);
    expect(fetch.manipulationRiskMeta.stale).toBe(false);
  });

  it('E2E.4 — buildManipulationHealthNode receives metadata from fetch envelope', async () => {
    computeManipulationFreshness.mockResolvedValue({
      latestScanAt: FRESH_AT,
      snapshotsPersisted30d: 478,
      status: 'FRESH',
      isStale: false,
      reason: 'ok',
    });

    const fetch = await fetchManipulationRiskForSignalPools(
      emptyPools(),
      universe,
      async (symbols) => new Map(symbols.map((s) => [s.toUpperCase(), freshRisk()])),
    );

    const node = buildManipulationHealthNode(baseHealthCtx(fetch.manipulationRiskMeta));

    expect(node.metrics.snapshotCount).toBe(fetch.manipulationRiskMeta.snapshotCount);
    expect(node.metrics.globalSnapshotCount).toBe(478);
    expect(node.metrics.symbolsQueried).toBe(MANIPULATION_FALLBACK_SAMPLE_SIZE);
    expect(node.inputCount).toBe(fetch.manipulationRiskMeta.symbolCount);
    expect(node.outputCount).toBe(fetch.manipulationRiskMeta.snapshotCount);
  });

  it.each([
    {
      label: 'fresh snapshots',
      meta: {
        configured: true,
        symbolCount: 20,
        snapshotCount: 18,
        freshestSnapshotAt: FRESH_AT,
        stale: false,
        globalSnapshotCount: 478,
        globalLatestScanAt: FRESH_AT,
      },
      fetchRisk: freshRisk,
      globalSnapshots: 478,
      expected: 'HEALTHY',
    },
    {
      label: 'stale snapshots',
      meta: null,
      fetchRisk: staleRisk,
      globalSnapshots: 478,
      expected: 'DEGRADED',
    },
    {
      label: 'no snapshots yet',
      meta: null,
      fetchRisk: noSnapshotRisk,
      globalSnapshots: 0,
      expected: 'INSUFFICIENT_DATA',
    },
    {
      label: 'scanner unavailable',
      meta: {
        configured: false,
        symbolCount: 0,
        snapshotCount: 0,
        freshestSnapshotAt: null,
        stale: false,
        globalSnapshotCount: 0,
        globalLatestScanAt: null,
      },
      fetchRisk: null,
      globalSnapshots: 0,
      expected: 'NOT_CONFIGURED',
      skipFetch: true,
    },
  ])(
    'E2E.5 — health status: $label → $expected',
    async ({ meta, fetchRisk, globalSnapshots, expected, skipFetch }) => {
      if (skipFetch) {
        const node = buildManipulationHealthNode(baseHealthCtx(meta!));
        expect(node.status).toBe(expected);
        return;
      }

      computeManipulationFreshness.mockResolvedValue({
        latestScanAt: globalSnapshots > 0 ? FRESH_AT : null,
        snapshotsPersisted30d: globalSnapshots,
        status: globalSnapshots > 0 ? 'FRESH' : 'NO_DATA',
        isStale: false,
        reason: 'test',
      });

      const fetch = await fetchManipulationRiskForSignalPools(
        emptyPools(),
        universe,
        async (symbols) =>
          new Map(symbols.map((s) => [s.toUpperCase(), fetchRisk!()])),
      );

      const resolvedMeta = meta ?? fetch.manipulationRiskMeta;
      const node = buildManipulationHealthNode(baseHealthCtx(resolvedMeta));
      const mapNode = buildEngineHealthMap(baseHealthCtx(resolvedMeta))
        .nodes.find((n) => n.id === 'manipulation');

      expect(node.status).toBe(expected);
      expect(mapNode?.status).toBe(expected);
    },
  );

  it('E2E.6 — full cycle: scheduler scan then health reads fresh metadata', async () => {
    vi.mocked(runDailyScan).mockResolvedValue(scanSuccess(478));
    await runManipulationDailyScanJob();

    computeManipulationFreshness.mockResolvedValue({
      latestScanAt: FRESH_AT,
      snapshotsPersisted30d: 478,
      status: 'FRESH',
      isStale: false,
      reason: 'post-scan',
    });

    const fetch = await fetchManipulationRiskForSignalPools(
      emptyPools(),
      universe,
      async (symbols) => new Map(symbols.map((s) => [s.toUpperCase(), freshRisk()])),
    );

    const health = buildManipulationHealthNode(baseHealthCtx(fetch.manipulationRiskMeta));

    expect(runDailyScan).toHaveBeenCalledWith({ skipIngestion: true });
    expect(fetch.manipulationRiskMeta.snapshotCount).toBeGreaterThan(0);
    expect(fetch.manipulationRiskMeta.globalSnapshotCount).toBe(478);
    expect(health.status).toBe('HEALTHY');
    expect(health.metrics.hardRejectionEnabled).toBe(true);
  });
});

describe('buildManipulationRiskMeta — scheduler post-condition', () => {
  it('reflects persisted snapshot count from risk map', () => {
    const map = new Map<string, ManipulationRisk>([
      ['RELIANCE', freshRisk()],
      ['TCS', freshRisk()],
      ['INFY', noSnapshotRisk()],
    ]);

    const meta = buildManipulationRiskMeta(map, {
      globalSnapshotCount: 478,
      globalLatestScanAt: FRESH_AT,
    });

    expect(meta.configured).toBe(true);
    expect(meta.symbolCount).toBe(3);
    expect(meta.snapshotCount).toBe(2);
    expect(meta.globalSnapshotCount).toBe(478);
  });
});
