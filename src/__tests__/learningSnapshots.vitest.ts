import { describe, expect, it } from 'vitest';
import {
  createLearningSnapshot,
  replayLearningSnapshot,
  verifyLearningSnapshot,
  type ImmutableLearningSnapshot,
} from '@/lib/signal-engine/learning/versionedLearningSnapshots';
import type { OutcomeAnalyticsRecord } from '@/lib/signal-engine/analytics/outcomeAnalytics';

const RECORDS: OutcomeAnalyticsRecord[] = [{
  signalId: 1,
  symbol: 'TEST',
  strategy: 'bullish_breakout',
  sector: 'IT',
  marketRegime: 'Bullish',
  timeframe: 'daily',
  generatedAt: '2026-01-01T00:00:00Z',
  predictedConfidence: 70,
  expectedRewardRisk: 1.5,
  outcome: {
    signalId: 1,
    entryTriggered: true,
    barsToEntry: 0,
    target1Hit: true,
    target2Hit: false,
    target3Hit: false,
    stopHit: false,
    maxFavorableExcursionPct: 7,
    maxAdverseExcursionPct: -1,
    pnlR: 1.5,
    returnAtBar5Pct: 4,
    returnAtBar10Pct: null,
    outcomeLabel: 'partial_success',
    evaluatedAt: '2026-01-10 00:00:00',
    exitReason: 'target1',
    holdingDurationBars: 3,
    realizedReturnPct: 7.5,
    realizedRewardRisk: 1.5,
  },
}];

const VERSIONS = {
  configurationVersion: '2.0.0',
  featureVersion: '2.0.0',
  confidenceVersion: '2.0.0',
  learningVersion: '3.0.0',
  benchmarkVersion: '3.0.0',
  outcomeVersion: '3.0.0',
};

describe('versioned learning snapshots', () => {
  it('creates immutable, content-addressed snapshots', () => {
    const snapshot = createLearningSnapshot({
      records: RECORDS,
      versions: VERSIONS,
      createdAt: '2026-01-11T00:00:00Z',
      lookbackDays: 90,
    });
    expect(snapshot.snapshotId).toMatch(/^learn_20260111_/);
    expect(snapshot.contentHash).toHaveLength(64);
    expect(verifyLearningSnapshot(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.benchmarkMetrics)).toBe(true);
  });

  it('detects snapshot tampering', () => {
    const snapshot = createLearningSnapshot({
      records: RECORDS,
      versions: VERSIONS,
      createdAt: '2026-01-11T00:00:00Z',
      lookbackDays: 90,
    });
    const tampered = JSON.parse(JSON.stringify(snapshot)) as ImmutableLearningSnapshot;
    tampered.versions.learningVersion = 'changed';
    expect(verifyLearningSnapshot(tampered)).toBe(false);
  });

  it('replays analytics at the snapshot timestamp', () => {
    const snapshot = createLearningSnapshot({
      records: RECORDS,
      versions: VERSIONS,
      createdAt: '2026-01-11T00:00:00Z',
      lookbackDays: 90,
    });
    const replay = replayLearningSnapshot(snapshot, RECORDS);
    expect(replay.generatedAt).toBe(snapshot.createdAt);
    expect(replay.overall.sampleCount).toBe(1);
  });
});
