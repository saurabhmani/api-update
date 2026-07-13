import { describe, expect, it } from 'vitest';
import { createLearningSnapshot } from '@/lib/signal-engine/learning/versionedLearningSnapshots';
import { detectDrift } from '@/lib/signal-engine/adaptive/driftDetection';
import type { OutcomeAnalyticsRecord } from '@/lib/signal-engine/analytics/outcomeAnalytics';

function record(win: boolean, confidence: number): OutcomeAnalyticsRecord {
  return {
    signalId: 1,
    symbol: 'TEST',
    strategy: 'bullish_breakout',
    sector: 'IT',
    marketRegime: 'Bullish',
    timeframe: 'daily',
    generatedAt: '2026-01-01T00:00:00Z',
    predictedConfidence: confidence,
    expectedRewardRisk: 1.5,
    outcome: {
      signalId: 1,
      entryTriggered: true,
      barsToEntry: 0,
      target1Hit: win,
      target2Hit: false,
      target3Hit: false,
      stopHit: !win,
      maxFavorableExcursionPct: 7,
      maxAdverseExcursionPct: -1,
      pnlR: win ? 1.5 : -1,
      returnAtBar5Pct: 4,
      returnAtBar10Pct: null,
      outcomeLabel: win ? 'partial_success' : 'stopped_out',
      evaluatedAt: '2026-01-10 00:00:00',
      exitReason: win ? 'target1' : 'stop',
      holdingDurationBars: 3,
      realizedReturnPct: win ? 7.5 : -3,
      realizedRewardRisk: win ? 1.5 : -1,
    },
  };
}

const VERSIONS = {
  configurationVersion: '2.0.0',
  featureVersion: '2.0.0',
  confidenceVersion: '2.0.0',
  learningVersion: '4.0.0',
  benchmarkVersion: '3.0.0',
  outcomeVersion: '3.0.0',
};

describe('drift detection', () => {
  it('emits performance drift alerts without modifying parameters', () => {
    const baselineRecords = Array.from({ length: 100 }, (_, i) => record(i % 2 === 0, 70));
    const currentRecords = Array.from({ length: 100 }, () => record(false, 70));
    const baseline = createLearningSnapshot({
      records: baselineRecords,
      versions: VERSIONS,
      createdAt: '2026-01-01T00:00:00Z',
      lookbackDays: 90,
    });
    const current = createLearningSnapshot({
      records: currentRecords,
      versions: VERSIONS,
      createdAt: '2026-02-01T00:00:00Z',
      lookbackDays: 90,
    });
    const report = detectDrift(baseline, current);
    expect(report.alertCount).toBeGreaterThan(0);
    expect(report.alerts.some((a) => a.category === 'performance_drift')).toBe(true);
  });
});
