import { describe, expect, it } from 'vitest';
import {
  getIntelligenceMode,
  resolveEngineHealthCheck,
} from '@/types/dashboard';
import { buildLightweightEngineHealthPreview, buildIndicatorHealthNode, buildDataFeedHealthNode, buildScannerHealthNode, buildDueDiligenceHealthNode, buildManipulationHealthNode, buildBacktestingHealthNode, buildPipelineReadiness } from '@/lib/signals/engineHealthMap';
import type { EngineHealthContext } from '@/lib/signals/engineHealthMap';

const baseFeedCtx = (feed: Partial<EngineHealthContext['feed']>, marketOpen = true): EngineHealthContext => ({
  generatedAt: new Date().toISOString(),
  marketStatus: { isOpen: marketOpen, label: marketOpen ? 'Market Open' : 'Market Closed', state: marketOpen ? 'open' : 'closed' },
  feed: {
    provider: 'kite',
    lastSuccessAt: new Date().toISOString(),
    lastApiRequestAt: new Date().toISOString(),
    isBootstrap: false,
    isFallback: false,
    staleMinutes: 80 * 60,
    freshnessLabel: 'stale',
    coveragePercent: null,
    symbolsRequested: null,
    symbolsReturned: null,
    candleAgeHours: 30,
    ...feed,
  },
  transport: {
    signalsAvailable: true, signalsTimedOut: false, signalsErrorMessage: null,
    dailyReportAvailable: false, backtestAvailable: false,
  },
  pipeline: {
    lastPipelineRunAt: new Date().toISOString(), lastConfirmedSignalAt: null,
    latestBatchId: 'batch-1', latestBatchEngineKind: 'phase4',
    scanCoveragePercent: 12, totalScanned: 50, totalPersisted: 50,
    universeSize: 500, inProgressCount: 0, validationStatus: 'ok',
  },
  signals: {
    approved: [], highPotential: [], watchlist: [], developing: [],
    scannerCandidates: [], riskRestricted: [], rejected: [],
  },
  counters: {
    approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
    highPotentialTotal: 0, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 0,
  },
  dueDiligenceSummary: null,
});

describe('buildDataFeedHealthNode', () => {
  it('stays HEALTHY for expected daily session gap during market hours', () => {
    const node = buildDataFeedHealthNode(baseFeedCtx({
      staleMinutes: 80 * 60,
      candleAgeHours: 30,
    }));
    expect(node.status).toBe('HEALTHY');
  });

  it('does not WARNING on low scan_coverage_percent mistakenly mapped as feed coverage', () => {
    const node = buildDataFeedHealthNode(baseFeedCtx({
      coveragePercent: 12,
      staleMinutes: 10,
      candleAgeHours: 1,
    }));
    expect(node.status).toBe('HEALTHY');
  });

  it('stays HEALTHY when warehouse is fine but signals envelope was delayed', () => {
    const node = buildDataFeedHealthNode({
      ...baseFeedCtx({ provider: null, lastSuccessAt: null }),
      transport: {
        signalsAvailable: false, signalsTimedOut: true, signalsErrorMessage: 'timeout',
        dailyReportAvailable: false, backtestAvailable: false,
      },
      feed: {
        ...baseFeedCtx({ provider: null, lastSuccessAt: null }).feed,
        provider: null,
        lastSuccessAt: null,
        candleCoverage: {
          latestCandleDate: new Date().toISOString().slice(0, 10),
          candleCount: 500,
          distinctSymbols: 200,
        },
      },
    });
    expect(node.status).toBe('HEALTHY');
  });
});

describe('buildScannerHealthNode', () => {
  const fridayRun = new Date(Date.now() - 80 * 60 * 60_000).toISOString();

  it('stays HEALTHY when last run is from prior session but candidates exist (Monday open)', () => {
    const node = buildScannerHealthNode({
      ...baseFeedCtx({ staleMinutes: 10, candleAgeHours: 1 }),
      signals: {
        approved: [], highPotential: [{ symbol: 'RELIANCE' } as any], watchlist: [],
        developing: [], scannerCandidates: [], riskRestricted: [], rejected: [],
      },
      counters: {
        approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
        highPotentialTotal: 1, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 1,
      },
      pipeline: {
        ...baseFeedCtx({}).pipeline,
        lastPipelineRunAt: fridayRun,
        totalScanned: 120,
        totalPersisted: 80,
        latestBatchId: 'batch_friday',
      },
    });
    expect(node.status).toBe('HEALTHY');
  });

  it('stays HEALTHY when market is closed even if last run is old', () => {
    const node = buildScannerHealthNode({
      ...baseFeedCtx({ staleMinutes: 10 }, false),
      pipeline: {
        ...baseFeedCtx({}).pipeline,
        lastPipelineRunAt: fridayRun,
        totalScanned: 100,
      },
      counters: {
        approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
        highPotentialTotal: 2, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 2,
      },
    });
    expect(node.status).toBe('HEALTHY');
  });

  it('is STALE only when no scan evidence and run is overdue during market hours', () => {
    const node = buildScannerHealthNode({
      ...baseFeedCtx({ staleMinutes: 10 }),
      signals: {
        approved: [], highPotential: [], watchlist: [], developing: [],
        scannerCandidates: [], riskRestricted: [], rejected: [],
      },
      counters: {
        approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
        highPotentialTotal: 0, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 0,
      },
      pipeline: {
        ...baseFeedCtx({}).pipeline,
        lastPipelineRunAt: fridayRun,
        totalScanned: 0,
        totalPersisted: 0,
        latestBatchId: null,
      },
    });
    expect(node.status).toBe('STALE');
  });
});

describe('buildIndicatorHealthNode — lite response rows', () => {
  const baseCtx = (rows: Record<string, unknown>[]): EngineHealthContext => ({
    generatedAt: new Date().toISOString(),
    marketStatus: { isOpen: true, label: 'Market Open', state: 'open' },
    feed: {
      provider: 'kite', lastSuccessAt: null, lastApiRequestAt: null,
      isBootstrap: false, isFallback: false, staleMinutes: 10,
      freshnessLabel: 'fresh', coveragePercent: 90,
      symbolsRequested: 100, symbolsReturned: 90, candleAgeHours: 1,
    },
    transport: {
      signalsAvailable: true, signalsTimedOut: false, signalsErrorMessage: null,
      dailyReportAvailable: false, backtestAvailable: false,
    },
    pipeline: {
      lastPipelineRunAt: new Date().toISOString(), lastConfirmedSignalAt: null,
      latestBatchId: 'batch-1', latestBatchEngineKind: 'phase4',
      scanCoveragePercent: 90, totalScanned: 100, totalPersisted: 90,
      universeSize: 500, inProgressCount: 0, validationStatus: 'ok',
    },
    signals: {
      approved: [], highPotential: rows as any[], watchlist: [],
      developing: [], scannerCandidates: [], riskRestricted: [], rejected: [],
    },
    counters: {
      approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
      highPotentialTotal: rows.length, watchlistTotal: 0,
      rejectedTotal: 0, candidateTotal: rows.length,
    },
    dueDiligenceSummary: null,
  });

  it('counts flattened elite scores when factor_scores blob is absent (lite=true)', () => {
    const node = buildIndicatorHealthNode(baseCtx([
      {
        symbol: 'RELIANCE',
        final_score: 82,
        confidence_score: 78,
        liquidity_score: 71,
        market_regime_score: 68,
        portfolio_fit_score: 74,
      },
      {
        symbol: 'TCS',
        final_score: 76,
        confidence_score: 72,
      },
    ]));
    expect(node.status).toBe('HEALTHY');
    expect(node.metrics.coveragePercent).toBe(100);
  });

  it('does not DEGRADED when composite scores exist without factor_scores JSON', () => {
    const node = buildIndicatorHealthNode(baseCtx([
      { symbol: 'INFY', final_score: 70, confidence_score: 65 },
    ]));
    expect(node.status).not.toBe('DEGRADED');
  });
});

describe('buildDueDiligenceHealthNode — pipeline readiness', () => {
  it('is HEALTHY when candidates exist but lite probe omitted dueDiligenceSummary', () => {
    const node = buildDueDiligenceHealthNode({
      ...baseFeedCtx({ staleMinutes: 10, candleAgeHours: 1 }),
      signals: {
        approved: [], highPotential: [{ symbol: 'RELIANCE' } as any], watchlist: [],
        developing: [], scannerCandidates: [], riskRestricted: [], rejected: [],
      },
      counters: {
        approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
        highPotentialTotal: 1, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 1,
      },
      dueDiligenceSummary: null,
    });
    expect(node.status).toBe('HEALTHY');
  });

  it('marks canRunDueDiligence true when due diligence node is HEALTHY', () => {
    const node = buildDueDiligenceHealthNode({
      ...baseFeedCtx({ staleMinutes: 10, candleAgeHours: 1 }),
      counters: {
        approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
        highPotentialTotal: 2, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 2,
      },
      signals: {
        approved: [], highPotential: [{ symbol: 'A' } as any, { symbol: 'B' } as any],
        watchlist: [], developing: [], scannerCandidates: [], riskRestricted: [], rejected: [],
      },
      dueDiligenceSummary: null,
    });
    const readiness = buildPipelineReadiness([
      { id: 'data_feed', status: 'HEALTHY' } as any,
      { id: 'scanner', status: 'HEALTHY' } as any,
      { id: 'scoring', status: 'HEALTHY' } as any,
      node,
      { id: 'daily_report', status: 'WARNING' } as any,
      { id: 'backtesting', status: 'WARNING' } as any,
    ]);
    expect(readiness.canRunDueDiligence).toBe(true);
    expect(readiness.blockingReasons.some((r) => r.includes('Due-diligence'))).toBe(false);
  });

  it('is HEALTHY when market is closed and no rows are in the sample', () => {
    const node = buildDueDiligenceHealthNode({
      ...baseFeedCtx({ staleMinutes: 10, candleAgeHours: 1 }, false),
      dueDiligenceSummary: null,
    });
    expect(node.status).toBe('HEALTHY');
  });
});

describe('buildBacktestingHealthNode — warehouse EOD lag', () => {
  it('softens warehouse lag warning for COMPLETE backtests', () => {
    const node = buildBacktestingHealthNode({
      ...baseFeedCtx({ staleMinutes: 10, candleAgeHours: 1 }),
      backtest: {
        available:       true,
        status:          'COMPLETE',
        window:          '1D',
        generatedAt:     new Date().toISOString(),
        symbolsWithData: 18,
        totalSymbols:    20,
        warnings:        [
          'Backtest end clipped to latest warehouse EOD session 2026-06-24 (requested 2026-06-27 not available yet).',
        ],
      },
    });
    expect(node.status).toBe('HEALTHY');
    expect(node.diagnostics.warnings.some((w) => w.includes('candles:daily'))).toBe(true);
    expect(node.diagnostics.warnings.some((w) => w.includes('2026-06-27'))).toBe(false);
  });

  it('recognizes legacy warehouse lag warning text', () => {
    const node = buildBacktestingHealthNode({
      ...baseFeedCtx({ staleMinutes: 10, candleAgeHours: 1 }),
      backtest: {
        available:       true,
        status:          'COMPLETE',
        window:          '1D',
        generatedAt:     new Date().toISOString(),
        symbolsWithData: 18,
        totalSymbols:    20,
        warnings:        [
          'Backtest end 2026-06-27 has no EOD bars yet — using latest warehouse session 2026-06-24.',
        ],
      },
    });
    expect(node.status).toBe('HEALTHY');
    expect(node.diagnostics.warnings.some((w) => w.includes('candles:daily'))).toBe(true);
  });

  it('downgrades to WARNING for PARTIAL with real outcome gaps', () => {
    const node = buildBacktestingHealthNode({
      ...baseFeedCtx({ staleMinutes: 10, candleAgeHours: 1 }),
      backtest: {
        available:       true,
        status:          'PARTIAL',
        window:          '7D',
        generatedAt:     new Date().toISOString(),
        symbolsWithData: 4,
        totalSymbols:    20,
        warnings:        [
          'Backtest end clipped to latest warehouse EOD session 2026-06-24 (requested 2026-06-27 not available yet).',
          'Historical candle data available for 4/20 symbols.',
        ],
      },
    });
    expect(node.status).toBe('WARNING');
  });
});

describe('buildManipulationHealthNode — metadata-driven status (3.x)', () => {
  const base = (signals = {
    approved: [] as unknown[],
    highPotential: [] as unknown[],
    watchlist: [] as unknown[],
    developing: [] as unknown[],
    scannerCandidates: [] as unknown[],
    riskRestricted: [] as unknown[],
    rejected: [] as unknown[],
  }) => ({
    ...baseFeedCtx({ staleMinutes: 10, candleAgeHours: 1 }),
    signals,
  });

  const freshMeta = {
    configured: true,
    symbolCount: 10,
    snapshotCount: 8,
    freshestSnapshotAt: '2026-06-22T15:30:00.000Z',
    stale: false,
    globalSnapshotCount: 8,
    globalLatestScanAt: '2026-06-22T15:30:00.000Z',
  };

  it('3.1 — configured scanner + fresh snapshots → HEALTHY', () => {
    const node = buildManipulationHealthNode({
      ...base(),
      manipulationRiskMeta: freshMeta,
    });
    expect(node.status).toBe('HEALTHY');
    expect(node.metrics.hardRejectionEnabled).toBe(true);
  });

  it('3.2 — configured scanner + stale snapshots → DEGRADED', () => {
    const node = buildManipulationHealthNode({
      ...base(),
      manipulationRiskMeta: {
        ...freshMeta,
        freshestSnapshotAt: '2026-06-01T10:00:00.000Z',
        stale: true,
      },
    });
    expect(node.status).toBe('DEGRADED');
    expect(node.metrics.warningOnlyMode).toBe(true);
  });

  it('3.3 — configured + no snapshots yet (global idle) → INSUFFICIENT_DATA', () => {
    const node = buildManipulationHealthNode({
      ...base(),
      manipulationRiskMeta: {
        configured: true,
        symbolCount: 20,
        snapshotCount: 0,
        freshestSnapshotAt: null,
        stale: false,
        globalSnapshotCount: 0,
        globalLatestScanAt: null,
      },
    });
    expect(node.status).toBe('INSUFFICIENT_DATA');
    expect(node.metrics.warningOnlyMode).toBe(true);
    expect(node.status).not.toBe('NOT_CONFIGURED');
  });

  it('3.3b — configured + global snapshots but probed pool uncovered → INSUFFICIENT_DATA', () => {
    const node = buildManipulationHealthNode({
      ...base(),
      manipulationRiskMeta: {
        configured: true,
        symbolCount: 20,
        snapshotCount: 0,
        freshestSnapshotAt: null,
        stale: false,
        globalSnapshotCount: 42,
        globalLatestScanAt: '2026-06-20T10:00:00.000Z',
      },
    });
    expect(node.status).toBe('INSUFFICIENT_DATA');
    expect(node.status).not.toBe('NOT_CONFIGURED');
  });

  it('3.4 — metadata missing → NOT_CONFIGURED', () => {
    const nodeAbsent = buildManipulationHealthNode(base());
    expect(nodeAbsent.status).toBe('NOT_CONFIGURED');

    const nodeUnconfigured = buildManipulationHealthNode({
      ...base(),
      manipulationRiskMeta: {
        configured: false,
        symbolCount: 0,
        snapshotCount: 0,
        freshestSnapshotAt: null,
        stale: false,
        globalSnapshotCount: 0,
        globalLatestScanAt: null,
      },
    });
    expect(nodeUnconfigured.status).toBe('NOT_CONFIGURED');
  });

  it('3.5 — zero approved signals never NOT_CONFIGURED when metadata exists', () => {
    const scenarios = [
      { ...freshMeta },
      {
        configured: true,
        symbolCount: 20,
        snapshotCount: 0,
        freshestSnapshotAt: null,
        stale: false,
        globalSnapshotCount: 0,
        globalLatestScanAt: null,
      },
      {
        configured: true,
        symbolCount: 10,
        snapshotCount: 8,
        freshestSnapshotAt: '2026-06-01T10:00:00.000Z',
        stale: true,
        globalSnapshotCount: 8,
        globalLatestScanAt: '2026-06-01T10:00:00.000Z',
      },
    ];
    for (const manipulationRiskMeta of scenarios) {
      const node = buildManipulationHealthNode({
        ...base({
          approved: [],
          highPotential: [],
          watchlist: [],
          developing: [],
          scannerCandidates: [],
          riskRestricted: [],
          rejected: [],
        }),
        manipulationRiskMeta,
      });
      expect(node.status).not.toBe('NOT_CONFIGURED');
    }
  });

  it('legacy gateImpact fallback when manipulationRiskMeta is absent', () => {
    const node = buildManipulationHealthNode({
      ...base(),
      manipulationGateImpact: {
        blockedFromApproval: 0,
        riskRestrictedCount: 0,
        penalizedCount: 0,
        warningOnlyCount: 0,
        blockedSymbols: [],
        riskRestrictedSymbols: [],
        active: false,
        dataStatus: 'FRESH',
        symbolsQueried: 20,
        symbolsWithEnvelope: 18,
        latestScanAt: new Date().toISOString(),
        latestEventDate: '2026-06-20',
        usedFallbackUniverse: true,
      },
    });
    expect(node.status).toBe('HEALTHY');
    expect(node.metrics.symbolsQueried).toBe(20);
  });
});

describe('buildLightweightEngineHealthPreview — daily session gap', () => {
  it('does not DEGRADED when Friday bar is frozen on Monday (daily tolerant)', () => {
    const preview = buildLightweightEngineHealthPreview({
      marketOpen:         true,
      isBootstrap:        false,
      isFallback:         false,
      staleMinutes:       80 * 60, // ~80h since Friday close
      freshnessMode:      'daily_tolerant',
      feedFrozen:         true,
      freshnessQuality:   'frozen',
      approvedTotal:      0,
      candidateTotal:     3,
    });
    expect(preview.overallStatus).toBe('HEALTHY');
    expect(preview.primaryBlockingReason).toBeNull();
  });

  it('stays HEALTHY off-hours for expected last-session snapshot age', () => {
    const preview = buildLightweightEngineHealthPreview({
      marketOpen:         false,
      isBootstrap:        false,
      isFallback:         false,
      staleMinutes:       80 * 60,
      freshnessMode:      'daily_tolerant',
      feedFrozen:         true,
      freshnessQuality:   'frozen',
      approvedTotal:      0,
      candidateTotal:     3,
    });
    expect(preview.overallStatus).toBe('HEALTHY');
  });
});

describe('resolveEngineHealthCheck', () => {
  it('returns healthy=true when market is open and engine is HEALTHY', () => {
    expect(resolveEngineHealthCheck(true, 'HEALTHY')).toEqual({
      healthy: true,
      status:  'HEALTHY',
      mode:    'OPERATIONAL',
    });
  });

  it('returns healthy=true when market is closed even if status is WARNING', () => {
    expect(resolveEngineHealthCheck(false, 'WARNING').healthy).toBe(true);
    expect(resolveEngineHealthCheck(false, 'WARNING').mode).toBe('MONITORING');
  });

  it('returns healthy=false with message when market is open and degraded', () => {
    const result = resolveEngineHealthCheck(true, 'DEGRADED', 'Candle feed frozen');
    expect(result.healthy).toBe(false);
    expect(result.message).toBe('Candle feed frozen');
    expect(result.mode).toBe('PARTIAL');
  });

  it('returns healthy=false for critical failure even when market is closed', () => {
    const result = resolveEngineHealthCheck(false, 'BROKEN');
    expect(result.healthy).toBe(false);
    expect(result.mode).toBe('RECOVERY');
    expect(result.message).toBe('Recovery Mode');
  });
});

describe('getIntelligenceMode', () => {
  it('prioritizes recovery over market closed', () => {
    expect(getIntelligenceMode(false, 'AUTH_REQUIRED')).toBe('RECOVERY');
  });
});
