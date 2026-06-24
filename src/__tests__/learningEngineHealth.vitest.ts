import { describe, expect, it } from 'vitest';
import {
  evaluateLearningPersistenceHealth,
  LEARNING_MATURE_OBSERVATION_THRESHOLD,
  type LearningPersistenceProbe,
} from '@/lib/learning/learningPersistenceProbe';
import { buildLearningHealthNode } from '@/lib/signals/engineHealthMap';
import type { EngineHealthContext } from '@/lib/signals/engineHealthMap';

function baseCtx(probe: LearningPersistenceProbe | null): EngineHealthContext {
  return {
    generatedAt: new Date().toISOString(),
    marketStatus: { isOpen: true, label: 'Market Open', state: 'open' },
    feed: {
      provider: 'candles_warehouse', lastSuccessAt: null, lastApiRequestAt: null,
      isBootstrap: false, isFallback: false, staleMinutes: null, freshnessLabel: null,
      coveragePercent: null, symbolsRequested: null, symbolsReturned: null, candleAgeHours: null,
    },
    pipeline: {
      lastPipelineRunAt: null, lastConfirmedSignalAt: null, latestBatchId: null,
      latestBatchEngineKind: null, scanCoveragePercent: null, totalScanned: null,
      totalPersisted: null, universeSize: null, inProgressCount: null, validationStatus: null,
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
    learningPersistence: probe,
  };
}

describe('evaluateLearningPersistenceHealth', () => {
  it('scenario A — table missing → NOT_CONFIGURED', () => {
    const r = evaluateLearningPersistenceHealth({
      tableExists: false, observationCount: 0, distinctStrategies: 0, lastReviewedAt: null,
    });
    expect(r.status).toBe('NOT_CONFIGURED');
    expect(r.readiness).toBe('NOT_CONFIGURED');
    expect(r.primaryIssue).toMatch(/not deployed/i);
  });

  it('scenario B — table exists, zero rows → INSUFFICIENT_DATA', () => {
    const r = evaluateLearningPersistenceHealth({
      tableExists: true, observationCount: 0, distinctStrategies: 0, lastReviewedAt: null,
    });
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.readiness).toBe('INSUFFICIENT_DATA');
    expect(r.primaryIssue).toMatch(/no persisted/i);
  });

  it('scenario C — 10 reviewed signals (<30) → INSUFFICIENT_DATA, not HEALTHY', () => {
    const r = evaluateLearningPersistenceHealth({
      tableExists: true, observationCount: 10, distinctStrategies: 3, lastReviewedAt: '2026-06-24T10:00:00Z',
    });
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.readiness).toBe('INSUFFICIENT_DATA');
    expect(r.status).not.toBe('HEALTHY');
    expect(r.warnings[0]).toContain('10');
    expect(r.warnings[0]).toContain(String(LEARNING_MATURE_OBSERVATION_THRESHOLD));
  });

  it('scenario D — mature dataset (≥30) → HEALTHY', () => {
    const r = evaluateLearningPersistenceHealth({
      tableExists: true, observationCount: 45, distinctStrategies: 8, lastReviewedAt: '2026-06-24T10:00:00Z',
    });
    expect(r.status).toBe('HEALTHY');
    expect(r.readiness).toBe('SUFFICIENT');
    expect(r.primaryIssue).toBeNull();
  });

  it('does not upgrade empty warehouse to HEALTHY when due diligence has rows', () => {
    const node = buildLearningHealthNode({
      ...baseCtx({
        tableExists: true, observationCount: 0, distinctStrategies: 0, lastReviewedAt: null,
      }),
      dueDiligenceSummary: { totalReviewed: 50 } as any,
    });
    expect(node.status).toBe('INSUFFICIENT_DATA');
    expect(node.status).not.toBe('HEALTHY');
  });
});

describe('buildLearningHealthNode', () => {
  it('maps probe metrics honestly for scenario C', () => {
    const node = buildLearningHealthNode(baseCtx({
      tableExists: true, observationCount: 10, distinctStrategies: 2, lastReviewedAt: '2026-06-24T12:00:00Z',
    }));
    expect(node.status).toBe('INSUFFICIENT_DATA');
    expect(node.metrics.observationCount).toBe(10);
    expect(node.metrics.readiness).toBe('INSUFFICIENT_DATA');
    expect(node.inputCount).toBe(10);
    expect(node.outputCount).toBe(10);
  });
});
