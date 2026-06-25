import { describe, expect, it } from 'vitest';
import {
  buildSignalLearningObservations,
  deriveLearningTagsForOutcome,
  resolveSignalId,
  type LearningReport,
} from '@/lib/learning/signalReviewEngine';
import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';

function baseRow(overrides: Partial<PerformanceOutcomeRow> = {}): PerformanceOutcomeRow {
  return {
    strategyId:      'momentum_breakout',
    symbol:          'RELIANCE',
    direction:       'BUY',
    sector:          null,
    regime:          null,
    confidenceScore: 72,
    outcome:         'LOSS',
    returnPct:       -2.5,
    returnR:         -1,
    targetHit:       false,
    stopHit:         true,
    invalidated:     false,
    mfePct:          1.2,
    maePct:          3.5,
    holdingPeriodBars: 6,
    approvalStatus:  'APPROVED',
    evaluatedAt:     '2026-06-01T10:00:00.000Z',
    source:          'direct',
    outcomeSource:   'direct',
    signalRef:       'outcome:99',
    signalId:        42,
    ...overrides,
  };
}

function minimalReport(): LearningReport {
  return {
    generatedAt:          '2026-06-24T12:00:00.000Z',
    timeWindow:           '90D',
    learningStatus:       'SUFFICIENT',
    totalReviewedSignals: 1,
    strategyRankings:     [],
    reviews: [{
      strategyId:       'momentum_breakout',
      strategyName:     'Momentum Breakout',
      reviewStatus:     'SUFFICIENT',
      totalReviewed:    1,
      whatWorked:       [],
      whatFailed:       [],
      calibrationNotes: [],
      learningTags:     ['stop_too_tight'],
      recommendation:   'Watch Carefully',
      explanation:      'test',
    }],
    conflictInsights:    [],
    calibrationWarnings: [],
    recommendations:     [],
    dataQuality: {
      status:                 'SUFFICIENT',
      evaluatedSignals:       1,
      minimumRequiredSignals: 5,
      warnings:               [],
    },
  };
}

describe('signalReviewEngine observation persistence helpers', () => {
  it('resolveSignalId returns signalId when present', () => {
    expect(resolveSignalId(baseRow())).toBe(42);
    expect(resolveSignalId(baseRow({ signalId: null }))).toBeNull();
  });

  it('deriveLearningTagsForOutcome tags stop hits', () => {
    const tags = deriveLearningTagsForOutcome(baseRow());
    expect(tags).toContain('stop_too_tight');
    expect(tags).toContain('false_breakout');
  });

  it('buildSignalLearningObservations dedupes by signal_id', () => {
    const outcomes = [
      baseRow({ signalId: 10 }),
      baseRow({ signalId: 10, symbol: 'TCS' }),
      baseRow({ signalId: 11, outcome: 'OPEN' }),
    ];
    const writes = buildSignalLearningObservations(outcomes, minimalReport());
    expect(writes).toHaveLength(1);
    expect(writes[0].signalId).toBe(10);
    expect(writes[0].recommendation).toBe('Watch Carefully');
    expect(writes[0].learningTags.length).toBeGreaterThan(0);
  });

  it('persists matured signals when strategy review is insufficient', () => {
    const report = minimalReport();
    report.reviews[0].recommendation = 'Insufficient Data';
    const writes = buildSignalLearningObservations([baseRow({ signalId: 55 })], report);
    expect(writes).toHaveLength(1);
    expect(writes[0].recommendation).toBe('Watch Carefully');
  });
});
