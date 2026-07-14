/**
 * Integration validation — manipulation risk fetch → response metadata →
 * engine health reporting. Exercises the same wiring as
 * /api/signals route + /api/signals/engine-health without HTTP.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/manipulation-engine/manipulationSignalRisk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/manipulation-engine/manipulationSignalRisk')>();
  return {
    ...actual,
    computeManipulationFreshness: vi.fn().mockResolvedValue({
      latestEventDate: null,
      latestCandleDate: '2026-06-23',
      latestScanAt: null,
      latestTradingDate: '2026-06-23',
      isStale: false,
      daysLag: null,
      status: 'NO_DATA',
      reason: 'test',
      snapshotsPersisted30d: 0,
    }),
  };
});

import {
  fetchManipulationRiskForSignalPools,
  MANIPULATION_FALLBACK_SAMPLE_SIZE,
  type FetchManipulationRiskResult,
} from '@/lib/signals/manipulationRiskFetch';
import {
  attachManipulationRiskToSignal,
  type ManipulationRisk,
} from '@/lib/manipulation-engine/manipulationSignalRisk';
import {
  buildEngineHealthMap,
  buildManipulationHealthNode,
  type EngineHealthContext,
} from '@/lib/signals/engineHealthMap';

const UNIVERSE = Array.from({ length: 25 }, (_, i) => `SYM${i + 1}`);
const FRESH_AT = new Date().toISOString().split('T')[0] + 'T13:41:10.000Z';
const STALE_AT = '2026-06-01T10:00:00.000Z';
const TODAY_SNAPSHOT_AT = `${new Date().toISOString().split('T')[0]}T12:00:00.000Z`;
const STALE_SNAPSHOT_AT = '2026-06-01T10:00:00.000Z';

const emptyPools = () => ({
  finalRows:          [] as Array<{ symbol?: string; tradingsymbol?: string }>,
  belowFloorDemoted:  [] as Array<{ symbol?: string; tradingsymbol?: string }>,
  inProgressEnriched: [] as Array<{ symbol?: string; tradingsymbol?: string }>,
});

const unknownRisk = (): ManipulationRisk => ({
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

const riskWithSnapshot = (
  latestScanAt: string,
  freshnessStatus: ManipulationRisk['freshnessStatus'] = 'FRESH',
  band: ManipulationRisk['band'] = 'ELEVATED',
): ManipulationRisk => ({
  score: 55,
  band,
  freshnessStatus,
  latestEventDate: '2026-06-19',
  latestScanAt,
  dominantPatterns: ['gap_fade'],
  alertCount: 1,
  criticalCount: 0,
  recommendedAction: 'WARNING_ONLY',
  canAffectApproval: false,
  explanation: '',
  evidence: [],
});

function mapForSymbols(
  symbols: string[],
  factory: (sym: string) => ManipulationRisk = () => unknownRisk(),
): Map<string, ManipulationRisk> {
  return new Map(symbols.map((sym) => [sym.toUpperCase(), factory(sym)]));
}

const baseHealthCtx = (): EngineHealthContext => ({
  generatedAt: new Date().toISOString(),
  marketStatus: { isOpen: true, label: 'Market Open', state: 'open' },
  feed: {
    provider: 'kite',
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
    universeSize: 500,
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
});

function gateImpactFromFetch(fetch: FetchManipulationRiskResult) {
  const meta = fetch.manipulationRiskMeta;
  if (!meta.configured) return undefined;
  return {
    blockedFromApproval:   0,
    riskRestrictedCount:   0,
    penalizedCount:        0,
    warningOnlyCount:      0,
    blockedSymbols:        [] as string[],
    riskRestrictedSymbols: [] as string[],
    active:                false,
    usedFallbackUniverse:  fetch.manipulationUsedFallbackUniverse,
    dataStatus:            meta.stale ? 'STALE' as const
                           : meta.snapshotCount > 0 ? 'FRESH' as const
                           : 'NO_DATA' as const,
    symbolsQueried:        meta.symbolCount,
    symbolsWithEnvelope:   meta.snapshotCount,
    latestScanAt:          meta.freshestSnapshotAt,
    latestEventDate:       null,
  };
}

const CANDIDATE_SYMBOLS = ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK'];

function candidatePools(count = 4) {
  const symbols = CANDIDATE_SYMBOLS.slice(0, count).map((symbol) => ({ symbol }));
  return {
    finalRows:          [] as Array<{ symbol?: string; tradingsymbol?: string }>,
    belowFloorDemoted:  [] as Array<{ symbol?: string; tradingsymbol?: string }>,
    inProgressEnriched: symbols,
  };
}

function candidateSignals(count = 4): EngineHealthContext['signals'] {
  const rows = CANDIDATE_SYMBOLS.slice(0, count).map((symbol) => ({ symbol }));
  return {
    approved: [],
    highPotential: [],
    watchlist: [],
    developing: rows,
    scannerCandidates: rows,
    riskRestricted: [],
    rejected: [],
  };
}

/** API contract shape exposed via engine-health manipulation node. */
function manipulationRiskHealth(status: string) {
  return { manipulation_risk: { status } };
}

async function runManipulationHealthCycle(
  pools: ReturnType<typeof emptyPools>,
  fetchImpl: (symbols: string[]) => Promise<ReadonlyMap<string, ManipulationRisk>>,
  signals?: EngineHealthContext['signals'],
) {
  const fetch = await fetchManipulationRiskForSignalPools(pools, UNIVERSE, fetchImpl);
  const ctx: EngineHealthContext = {
    ...baseHealthCtx(),
    signals: signals ?? baseHealthCtx().signals,
    manipulationRiskMeta:   fetch.manipulationRiskMeta,
    manipulationGateImpact: gateImpactFromFetch(fetch),
  };
  const healthNode = buildManipulationHealthNode(ctx);
  const engineMap = buildEngineHealthMap(ctx);
  const manipulationNode = engineMap.nodes.find((n) => n.id === 'manipulation');
  return { fetch, ctx, healthNode, manipulationNode };
}

describe('manipulation_risk status contract — Scenarios A–D', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Scenario A — fresh snapshots generated today → HEALTHY', async () => {
    const { fetch, healthNode, manipulationNode } = await runManipulationHealthCycle(
      candidatePools(4),
      async (symbols) => mapForSymbols(symbols, () => riskWithSnapshot(FRESH_AT)),
      candidateSignals(4),
    );

    expect(fetch.manipulationRiskMeta).toMatchObject({
      configured: true,
      snapshotCount: 4,
      stale: false,
    });
    expect(manipulationRiskHealth(healthNode.status)).toEqual({
      manipulation_risk: { status: 'HEALTHY' },
    });
    expect(manipulationNode?.status).toBe('HEALTHY');
  });

  it('Scenario B — snapshots older than freshness threshold → DEGRADED', async () => {
    const { fetch, healthNode, manipulationNode } = await runManipulationHealthCycle(
      emptyPools(),
      async (symbols) => mapForSymbols(symbols, () => riskWithSnapshot(STALE_AT, 'STALE')),
    );

    expect(fetch.manipulationRiskMeta.stale).toBe(true);
    expect(manipulationRiskHealth(healthNode.status)).toEqual({
      manipulation_risk: { status: 'DEGRADED' },
    });
    expect(manipulationNode?.status).toBe('DEGRADED');
  });

  it('Scenario C — new deployment, no snapshots yet → INSUFFICIENT_DATA', async () => {
    const { fetch, healthNode, manipulationNode } = await runManipulationHealthCycle(
      emptyPools(),
      async (symbols) => mapForSymbols(symbols, () => unknownRisk()),
    );

    expect(fetch.manipulationRiskMeta).toMatchObject({
      configured: true,
      snapshotCount: 0,
      globalSnapshotCount: 0,
    });
    expect(manipulationRiskHealth(healthNode.status)).toEqual({
      manipulation_risk: { status: 'INSUFFICIENT_DATA' },
    });
    expect(manipulationNode?.status).toBe('INSUFFICIENT_DATA');
  });

  it('Scenario D — scanner disabled or unavailable → NOT_CONFIGURED', async () => {
    const { fetch, healthNode, manipulationNode } = await runManipulationHealthCycle(
      candidatePools(4),
      async () => { throw new Error('scanner DB unreachable'); },
      candidateSignals(4),
    );

    expect(fetch.manipulationRiskMeta).toMatchObject({
      configured: false,
      symbolCount: 0,
      snapshotCount: 0,
    });
    expect(manipulationRiskHealth(healthNode.status)).toEqual({
      manipulation_risk: { status: 'NOT_CONFIGURED' },
    });
    expect(manipulationNode?.status).toBe('NOT_CONFIGURED');
  });
});

describe('manipulation health integration — signal enrichment', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('pool coverage gap (global snapshots exist, probed pool empty) → INSUFFICIENT_DATA', async () => {
    const pools = candidatePools(4);
    const fetch = await fetchManipulationRiskForSignalPools(
      pools,
      UNIVERSE,
      async (symbols) => mapForSymbols(symbols, () => unknownRisk()),
    );
    const meta = {
      ...fetch.manipulationRiskMeta,
      globalSnapshotCount: 150,
      globalLatestScanAt: '2026-06-20T10:00:00.000Z',
    };
    const healthNode = buildManipulationHealthNode({
      ...baseHealthCtx(),
      signals: candidateSignals(4),
      manipulationRiskMeta: meta,
      manipulationGateImpact: gateImpactFromFetch({ ...fetch, manipulationRiskMeta: meta }),
    });
    expect(healthNode.status).toBe('INSUFFICIENT_DATA');
  });

  it('approved signals exist → manipulation envelopes attached', async () => {
    const pools = {
      finalRows:          [{ symbol: 'RELIANCE' }, { symbol: 'TCS' }],
      belowFloorDemoted:  [] as Array<{ symbol?: string }>,
      inProgressEnriched: [] as Array<{ symbol?: string }>,
    };

    const { fetch, healthNode } = await runManipulationHealthCycle(
      pools,
      async (symbols) => mapForSymbols(symbols, () => riskWithSnapshot(FRESH_AT)),
    );

    expect(fetch.manipulationRiskMap).toBeDefined();
    expect(manipulationRiskHealth(healthNode.status)).toEqual(
      manipulationRiskHealth('HEALTHY'),
    );

    const map = fetch.manipulationRiskMap!;
    const enriched = pools.finalRows.map((row) => attachManipulationRiskToSignal(row, map));

    for (const row of enriched) {
      expect(row.manipulationRisk).toBeDefined();
      expect(row.manipulationRisk.latestScanAt).toBe(FRESH_AT);
      expect(row.manipulationRisk.band).not.toBe('UNKNOWN');
    }
  });
});

describe('manipulation health integration — fetch → meta → health', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('I.1 — zero-signal cycle with scanner snapshots → HEALTHY, meta present, no false NOT_CONFIGURED', async () => {
    const { fetch, healthNode, manipulationNode } = await runManipulationHealthCycle(
      emptyPools(),
      async (symbols) => mapForSymbols(symbols, () => riskWithSnapshot(FRESH_AT)),
    );

    expect(fetch.manipulationUsedFallbackUniverse).toBe(true);
    expect(fetch.manipulationRiskMeta).toMatchObject({
      configured: true,
      symbolCount: MANIPULATION_FALLBACK_SAMPLE_SIZE,
      snapshotCount: MANIPULATION_FALLBACK_SAMPLE_SIZE,
      freshestSnapshotAt: FRESH_AT,
      stale: false,
    });
    expect(healthNode.status).toBe('HEALTHY');
    expect(healthNode.status).not.toBe('NOT_CONFIGURED');
    expect(manipulationNode?.status).toBe('HEALTHY');
    expect(healthNode.inputCount).toBe(MANIPULATION_FALLBACK_SAMPLE_SIZE);
    expect(healthNode.outputCount).toBe(MANIPULATION_FALLBACK_SAMPLE_SIZE);
    expect(healthNode.metrics.symbolsQueried).toBe(MANIPULATION_FALLBACK_SAMPLE_SIZE);
    expect(healthNode.metrics.snapshotCount).toBe(MANIPULATION_FALLBACK_SAMPLE_SIZE);
  });

  it('I.2 — zero-signal cycle without snapshots (global idle) → INSUFFICIENT_DATA, not NOT_CONFIGURED', async () => {
    const { fetch, healthNode, manipulationNode } = await runManipulationHealthCycle(
      emptyPools(),
      async (symbols) => mapForSymbols(symbols, () => unknownRisk()),
    );

    expect(fetch.manipulationUsedFallbackUniverse).toBe(true);
    expect(fetch.manipulationRiskMeta).toMatchObject({
      configured: true,
      symbolCount: MANIPULATION_FALLBACK_SAMPLE_SIZE,
      snapshotCount: 0,
      globalSnapshotCount: 0,
    });
    expect(healthNode.status).toBe('INSUFFICIENT_DATA');
    expect(healthNode.status).not.toBe('NOT_CONFIGURED');
    expect(manipulationNode?.status).toBe('INSUFFICIENT_DATA');
  });

  it('I.3 — normal signal cycle → HEALTHY, signal enrichment attaches manipulationRisk', async () => {
    const pools = {
      finalRows:          [{ symbol: 'RELIANCE' }, { symbol: 'TCS' }],
      belowFloorDemoted:  [] as Array<{ symbol?: string }>,
      inProgressEnriched: [{ symbol: 'INFY' }],
    };

    const { fetch, healthNode } = await runManipulationHealthCycle(
      pools,
      async (symbols) => mapForSymbols(symbols, () => riskWithSnapshot(FRESH_AT)),
    );

    expect(fetch.manipulationUsedFallbackUniverse).toBe(false);
    expect(fetch.manipulationRiskMeta.configured).toBe(true);
    expect(fetch.manipulationRiskMeta.symbolCount).toBe(3);
    expect(fetch.manipulationRiskMeta.snapshotCount).toBe(3);
    expect(healthNode.status).toBe('HEALTHY');

    const map = fetch.manipulationRiskMap!;
    const enrichedApproved = pools.finalRows.map((row) => attachManipulationRiskToSignal(row, map));
    const enrichedDeveloping = pools.inProgressEnriched.map((row) => attachManipulationRiskToSignal(row, map));

    for (const row of [...enrichedApproved, ...enrichedDeveloping]) {
      expect(row.manipulationRisk).toBeDefined();
      expect(row.manipulationRisk.latestScanAt).toBe(FRESH_AT);
      expect(row.manipulationRisk.freshnessStatus).toBe('FRESH');
    }

    const enrichedCtx: EngineHealthContext = {
      ...baseHealthCtx(),
      signals: {
        approved: enrichedApproved,
        highPotential: [],
        watchlist: [],
        developing: enrichedDeveloping,
        scannerCandidates: [],
        riskRestricted: [],
        rejected: [],
      },
      manipulationRiskMeta:   fetch.manipulationRiskMeta,
      manipulationGateImpact: gateImpactFromFetch(fetch),
    };
    const enrichedHealth = buildManipulationHealthNode(enrichedCtx);
    expect(enrichedHealth.status).toBe('HEALTHY');
    expect(enrichedHealth.metrics.symbolsWithRisk).toBeGreaterThan(0);
  });

  it('I.4 — scanner unavailable (fetch throws) → NOT_CONFIGURED, meta still present on result', async () => {
    const { fetch, healthNode, manipulationNode } = await runManipulationHealthCycle(
      emptyPools(),
      async () => { throw new Error('scanner DB unreachable'); },
    );

    expect(fetch.manipulationRiskMap).toBeUndefined();
    expect(fetch.manipulationRiskMeta).toMatchObject({
      configured: false,
      symbolCount: 0,
      snapshotCount: 0,
    });
    expect(fetch).toHaveProperty('manipulationRiskMeta');
    expect(healthNode.status).toBe('NOT_CONFIGURED');
    expect(manipulationNode?.status).toBe('NOT_CONFIGURED');
  });

  it('I.5 — stale snapshots on zero-signal cycle → DEGRADED (reflects scanner state)', async () => {
    const { fetch, healthNode } = await runManipulationHealthCycle(
      emptyPools(),
      async (symbols) => mapForSymbols(symbols, () => riskWithSnapshot('2026-06-01T10:00:00.000Z', 'STALE')),
    );

    expect(fetch.manipulationRiskMeta.stale).toBe(true);
    expect(healthNode.status).toBe('DEGRADED');
    expect(healthNode.status).not.toBe('NOT_CONFIGURED');
  });

  it('I.6 — engine-health map manipulation node matches standalone builder', async () => {
    const { healthNode, manipulationNode } = await runManipulationHealthCycle(
      emptyPools(),
      async (symbols) => mapForSymbols(symbols, () => riskWithSnapshot(FRESH_AT)),
    );

    expect(manipulationNode).toBeDefined();
    expect(manipulationNode!.status).toBe(healthNode.status);
    expect(manipulationNode!.metrics.hardRejectionEnabled).toBe(healthNode.metrics.hardRejectionEnabled);
  });
});
