import { describe, expect, it } from 'vitest';
import {
  getIntelligenceMode,
  resolveEngineHealthCheck,
} from '@/types/dashboard';
import { buildLightweightEngineHealthPreview, buildIndicatorHealthNode, buildDataFeedHealthNode, buildScannerHealthNode, buildDueDiligenceHealthNode, buildDailyReportHealthNode, buildPipelineReadiness } from '@/lib/signals/engineHealthMap';
import type { EngineHealthContext } from '@/lib/signals/engineHealthMap';

const baseFeedCtx = (feed: Partial<EngineHealthContext['feed']>, marketOpen = true): EngineHealthContext => ({
  generatedAt: new Date().toISOString(),
  marketStatus: { isOpen: marketOpen, label: marketOpen ? 'Market Open' : 'Market Closed', state: marketOpen ? 'open' : 'closed' },
  feed: {
    provider: 'indianapi',
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
      provider: 'indianapi', lastSuccessAt: null, lastApiRequestAt: null,
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

describe('buildDailyReportHealthNode — PARTIAL is normal operation', () => {
  const withDailyReport = (reportStatus: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA' | 'PENDING') => ({
    ...baseFeedCtx({ staleMinutes: 10, candleAgeHours: 1 }),
    dailyReport: {
      available: true,
      reportStatus,
      generatedAt: new Date().toISOString(),
      warnings: reportStatus === 'PARTIAL'
        ? ['Daily report is partial — some sections are awaiting post-signal data.']
        : [],
    },
    counters: {
      approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
      highPotentialTotal: 3, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 3,
    },
    signals: {
      approved: [],
      highPotential: [{ symbol: 'A' } as any, { symbol: 'B' } as any, { symbol: 'C' } as any],
      watchlist: [], developing: [], scannerCandidates: [], riskRestricted: [], rejected: [],
    },
  });

  it('stays HEALTHY when reportStatus is PARTIAL (awaiting outcome sections)', () => {
    const node = buildDailyReportHealthNode(withDailyReport('PARTIAL'));
    expect(node.status).toBe('HEALTHY');
    expect(node.metrics.reportStatus).toBe('PARTIAL');
  });

  it('stays HEALTHY when reportStatus is INSUFFICIENT_DATA but pipeline rows exist', () => {
    const node = buildDailyReportHealthNode(withDailyReport('INSUFFICIENT_DATA'));
    expect(node.status).toBe('HEALTHY');
  });

  it('was WARNING before fix when reportStatus was PARTIAL', () => {
    // Document the root cause: PARTIAL mapped to WARNING in engine health.
    const node = buildDailyReportHealthNode(withDailyReport('PARTIAL'));
    expect(node.status).not.toBe('WARNING');
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
