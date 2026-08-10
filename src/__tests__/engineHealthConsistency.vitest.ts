import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildDataFeedHealthNode,
  buildEngineHealthMap,
  buildPipelineReadiness,
  deriveOverallStatus,
} from '@/lib/signals/engineHealthMap';
import type { EngineHealthContext } from '@/lib/signals/engineHealthMap';
import {
  engineDebugger,
  runWithEngineDebugAsync,
  withEngineDebug,
} from '@/lib/engineDebug/engineDebugger';

function baseCtx(overrides: Partial<EngineHealthContext> = {}): EngineHealthContext {
  return {
    generatedAt: new Date().toISOString(),
    marketStatus: { isOpen: false, label: 'Market Closed', state: 'closed' },
    feed: {
      provider: 'last_close_signals',
      lastSuccessAt: new Date().toISOString(),
      lastApiRequestAt: new Date().toISOString(),
      isBootstrap: false,
      isFallback: false,
      staleMinutes: 120,
      freshnessLabel: 'fresh',
      coveragePercent: null,
      symbolsRequested: null,
      symbolsReturned: null,
      candleAgeHours: 2,
    },
    transport: {
      signalsAvailable: true, signalsTimedOut: false, signalsErrorMessage: null,
      dailyReportAvailable: true, backtestAvailable: true,
    },
    pipeline: {
      lastPipelineRunAt: new Date().toISOString(), lastConfirmedSignalAt: null,
      latestBatchId: 'batch-1', latestBatchEngineKind: 'phase4',
      scanCoveragePercent: 12, totalScanned: 50, totalPersisted: 50,
      universeSize: 500, inProgressCount: 0, validationStatus: 'ok',
    },
    signals: {
      approved: [], highPotential: [{ symbol: 'RELIANCE' } as any], watchlist: [],
      developing: [], scannerCandidates: [], riskRestricted: [], rejected: [],
    },
    counters: {
      approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
      highPotentialTotal: 1, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 1,
    },
    dueDiligenceSummary: null,
    ...overrides,
  };
}

describe('closed-market isFallback must not mean provider fallback', () => {
  it('keeps data_feed HEALTHY when market is closed and isFallback=false', () => {
    const node = buildDataFeedHealthNode(baseCtx({
      feed: {
        ...baseCtx().feed,
        isFallback: false,
        provider: 'last_close_signals',
      },
    }));
    expect(node.status).toBe('HEALTHY');
    expect(node.diagnostics.primaryIssue).toBeNull();
  });

  it('marks data_feed DEGRADED only for real provider fallback', () => {
    const node = buildDataFeedHealthNode(baseCtx({
      marketStatus: { isOpen: true, label: 'Market Open', state: 'open' },
      feed: {
        ...baseCtx().feed,
        isFallback: true,
        liveFeedQuality: null,
      },
    }));
    expect(node.status).toBe('DEGRADED');
    expect(node.diagnostics.primaryIssue).toMatch(/fallback path/i);
  });

  it('overall is not forced DEGRADED by a healthy closed-market feed', () => {
    const healthyFeed = buildEngineHealthMap(baseCtx({
      feed: { ...baseCtx().feed, isFallback: false },
    }));
    const falseFallback = buildEngineHealthMap(baseCtx({
      feed: { ...baseCtx().feed, isFallback: true },
    }));

    const feedHealthy = healthyFeed.nodes.find((n) => n.id === 'data_feed');
    const feedDegraded = falseFallback.nodes.find((n) => n.id === 'data_feed');
    expect(feedHealthy?.status).toBe('HEALTHY');
    expect(feedDegraded?.status).toBe('DEGRADED');

    // The false-positive isFallback path is what previously made overall DEGRADED
    // while Dashboard healthPreview (isFallback:false) stayed HEALTHY.
    expect(falseFallback.pipelineReadiness.canGenerateCandidates).toBe(false);
    expect(falseFallback.overallStatus).toBe('DEGRADED');

    // With the bug fixed, a healthy closed-market feed must not be the blocker.
    expect(healthyFeed.pipelineReadiness.blockingReasons.join(' '))
      .not.toMatch(/Data feed unavailable/i);
    if (healthyFeed.pipelineReadiness.canGenerateCandidates) {
      expect(healthyFeed.overallStatus).not.toBe('DEGRADED');
    }
  });

  it('false isFallback=true on closed market incorrectly blocks candidates', () => {
    const nodes = [
      buildDataFeedHealthNode(baseCtx({
        feed: { ...baseCtx().feed, isFallback: true },
      })),
    ];
    // Isolate the feed node effect on readiness via full map
    const map = buildEngineHealthMap(baseCtx({
      feed: { ...baseCtx().feed, isFallback: true },
    }));
    expect(nodes[0].status).toBe('DEGRADED');
    expect(map.pipelineReadiness.canGenerateCandidates).toBe(false);
    expect(deriveOverallStatus(map.nodes, map.pipelineReadiness)).toBe('DEGRADED');
  });
});

describe('engineDebugger', () => {
  let tmpLog: string;
  const prevPath = process.env.ENGINE_DEBUG_LOG_PATH;
  const prevEnabled = process.env.ENGINE_DEBUG;

  beforeEach(() => {
    tmpLog = path.join(os.tmpdir(), `engine-debug-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    process.env.ENGINE_DEBUG_LOG_PATH = tmpLog;
    process.env.ENGINE_DEBUG = '1';
  });

  afterEach(() => {
    if (prevPath === undefined) delete process.env.ENGINE_DEBUG_LOG_PATH;
    else process.env.ENGINE_DEBUG_LOG_PATH = prevPath;
    if (prevEnabled === undefined) delete process.env.ENGINE_DEBUG;
    else process.env.ENGINE_DEBUG = prevEnabled;
    try { fs.unlinkSync(tmpLog); } catch { /* ignore */ }
  });

  it('writes START/END with file, function, requestId, durationMs', async () => {
    await runWithEngineDebugAsync(
      { requestId: 'req-test-1', engine: 'signal-engine' },
      async () => {
        await withEngineDebug(
          {
            function: 'checkEngineHealth',
            engine: 'signal-engine',
            file: 'src/lib/engineDebug/engineDebugger.ts',
            requestId: 'req-test-1',
          },
          async () => 'ok',
        );
      },
    );

    // Flush async write queue
    await new Promise((r) => setTimeout(r, 50));
    const text = fs.readFileSync(tmpLog, 'utf8');
    expect(text).toMatch(/\[ENGINE_DEBUG\]/);
    expect(text).toMatch(/\[requestId=req-test-1\]/);
    expect(text).toMatch(/\[file=/);
    expect(text).toMatch(/\[function=checkEngineHealth\]/);
    expect(text).toMatch(/\[engine=signal-engine\]/);
    expect(text).toMatch(/\[START\]/);
    expect(text).toMatch(/\[END\].*durationMs=\d+.*status=success/);
  });

  it('redacts secrets in error messages', async () => {
    const span = engineDebugger.start({
      function: 'leakCheck',
      file: 'src/lib/engineDebug/engineDebugger.ts',
      requestId: 'req-redact',
    });
    span.error(new Error('password=supersecret token=abc123'));
    await new Promise((r) => setTimeout(r, 50));
    const text = fs.readFileSync(tmpLog, 'utf8');
    expect(text).not.toMatch(/supersecret/);
    expect(text).not.toMatch(/abc123/);
    expect(text).toMatch(/\[REDACTED\]/);
  });
});

describe('pipeline readiness vs deriveOverallStatus', () => {
  it('single core DEGRADED data_feed without candidates → DEGRADED overall', () => {
    const map = buildEngineHealthMap(baseCtx({
      marketStatus: { isOpen: true, label: 'Open', state: 'open' },
      feed: { ...baseCtx().feed, isFallback: true, liveFeedQuality: null },
      signals: {
        approved: [], highPotential: [], watchlist: [],
        developing: [], scannerCandidates: [], riskRestricted: [], rejected: [],
      },
      counters: {
        approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
        highPotentialTotal: 0, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 0,
      },
    }));
    const readiness = buildPipelineReadiness(map.nodes);
    expect(readiness.canGenerateCandidates).toBe(false);
    expect(deriveOverallStatus(map.nodes, readiness)).toBe('DEGRADED');
  });
});
