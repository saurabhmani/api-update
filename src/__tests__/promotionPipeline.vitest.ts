import { describe, expect, it, beforeEach } from 'vitest';
import type { OutcomeAnalyticsRecord } from '@/lib/signal-engine/analytics/outcomeAnalytics';
import { clearAdaptiveParameterStore } from '@/lib/signal-engine/adaptive/adaptiveParameterStore';
import { clearAdaptiveAuditTrail } from '@/lib/signal-engine/adaptive/learningAudit';
import {
  approveParameter,
  buildCandidateFromSnapshot,
  promoteParameter,
  registerCandidate,
  rollbackParameter,
  runValidation,
} from '@/lib/signal-engine/adaptive/promotionPipeline';
import { deriveCandidateParameters } from '@/lib/signal-engine/adaptive/deriveCandidateParameters';
import { createLearningSnapshot } from '@/lib/signal-engine/learning/versionedLearningSnapshots';
import { DEFAULT_VALIDATION_THRESHOLDS } from '@/lib/signal-engine/adaptive/statisticalValidation';

function makeRecords(n: number, winRate = 0.45): OutcomeAnalyticsRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    signalId: i + 1,
    symbol: 'TEST',
    strategy: 'bullish_breakout',
    sector: 'IT',
    marketRegime: 'Bullish',
    timeframe: 'daily',
    generatedAt: `2026-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    predictedConfidence: 70,
    expectedRewardRisk: 1.5,
    outcome: {
      signalId: i + 1,
      entryTriggered: true,
      barsToEntry: 0,
      target1Hit: i / n < winRate,
      target2Hit: false,
      target3Hit: false,
      stopHit: false,
      maxFavorableExcursionPct: 7,
      maxAdverseExcursionPct: -1,
      pnlR: i / n < winRate ? 1.2 : -0.8,
      returnAtBar5Pct: 4,
      returnAtBar10Pct: null,
      outcomeLabel: 'partial_success',
      evaluatedAt: '2026-01-10 00:00:00',
      exitReason: i / n < winRate ? 'target1' : 'stop',
      holdingDurationBars: 3,
      realizedReturnPct: i / n < winRate ? 7.5 : -3,
      realizedRewardRisk: i / n < winRate ? 1.2 : -0.8,
    },
  }));
}

const VERSIONS = {
  configurationVersion: '2.0.0',
  featureVersion: '2.0.0',
  confidenceVersion: '2.0.0',
  learningVersion: '4.0.0',
  benchmarkVersion: '3.0.0',
  outcomeVersion: '3.0.0',
};

describe('promotion pipeline', () => {
  beforeEach(() => {
    clearAdaptiveParameterStore();
    clearAdaptiveAuditTrail();
  });

  it('rejects candidates that fail statistical validation', () => {
    const records = makeRecords(50);
    const snapshot = createLearningSnapshot({
      records,
      versions: VERSIONS,
      createdAt: '2026-01-11T00:00:00Z',
      lookbackDays: 90,
    });
    const candidate = buildCandidateFromSnapshot({
      configurationVersion: '2.0.0',
      sourceSnapshotId: snapshot.snapshotId,
      trainingWindowDays: 90,
      records,
      parameters: deriveCandidateParameters(snapshot),
      createdAt: '2026-01-11T00:00:00Z',
    });
    registerCandidate(candidate);
    const result = runValidation(candidate.parameterId, records);
    expect(result.status).toBe('rejected');
    expect(result.validationPassed).toBe(false);
  });

  it('promotes only after validation and approval', () => {
    const records = makeRecords(150, 0.5);
    const snapshot = createLearningSnapshot({
      records,
      versions: VERSIONS,
      createdAt: '2026-01-11T00:00:00Z',
      lookbackDays: 90,
    });
    const candidate = buildCandidateFromSnapshot({
      configurationVersion: '2.0.0',
      sourceSnapshotId: snapshot.snapshotId,
      trainingWindowDays: 90,
      records,
      parameters: deriveCandidateParameters(snapshot),
      createdAt: '2026-01-11T00:00:00Z',
    });
    registerCandidate(candidate);
    const validation = runValidation(candidate.parameterId, records, {
      ...DEFAULT_VALIDATION_THRESHOLDS,
      minSampleSize: 100,
      minWinCount: 30,
    });
    expect(validation.validationPassed).toBe(true);
    approveParameter(candidate.parameterId, 'operator', 'Manual approval');
    const promoted = promoteParameter(candidate.parameterId, 'operator', 'Promote', '2026-01-11T01:00:00Z');
    expect(promoted.status).toBe('promoted');
    const rolled = rollbackParameter(candidate.parameterId, 'operator', 'Rollback test');
    expect(rolled.status).toBe('rolled_back');
  });
});
