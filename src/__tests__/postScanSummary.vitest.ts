import { describe, it, expect, beforeEach } from 'vitest';
import {
  resetStrategyScanHistogram,
  recordStrategyEvaluation,
  recordStrategyOutcome,
  snapshotStrategyScanHistogram,
} from '@/lib/signal-engine/observability/strategyScanHistogram';
import { buildPostScanSummary } from '@/lib/signal-engine/observability/postScanSummary';
import { createDiscoveryGateCounters } from '@/lib/signal-engine/discovery/signalDiscoveryStatus';

describe('postScanSummary', () => {
  beforeEach(() => {
    resetStrategyScanHistogram();
  });

  it('builds funnel counts from stage + discovery counters', () => {
    recordStrategyEvaluation('bullish_breakout', 'rejected', 'RSI too low');
    recordStrategyEvaluation('bullish_breakout', 'matched');
    recordStrategyOutcome({
      strategy: 'bullish_breakout',
      signalQualityStatus: 'CONFIRMED_SIGNAL',
      technicalRejected: false,
      finalScore: 82,
    });

    const discovery = createDiscoveryGateCounters();
    discovery.confirmedSignals = 1;
    discovery.portfolioBlocked = 2;

    const summary = buildPostScanSummary({
      generationSource: 'test',
      regime: 'Bullish',
      universeTotal: 100,
      stageReached: {
        candle_valid: 95,
        features_valid: 90,
        strategy_match: 40,
        trade_plan_ok: 35,
        decision_stage: 30,
      },
      generatedCandidates: 12,
      discoveryGateCounters: discovery,
      rejectionHistogram: {
        noTrade: 5,
        rejectedByStrategyMode: 1,
        rejectedByFinalScore: 3,
        rejectedByDataQuality: 8,
      },
      scanCounters: { scanned: 100, approved: 4, deferred: 3, rejected: 5 },
      signalsSaved: 12,
    });

    expect(summary.universeTotal).toBe(100);
    expect(summary.candlesValid).toBe(95);
    expect(summary.confirmedSignals).toBe(1);
    expect(summary.portfolioBlocked).toBe(2);
    expect(summary.rejectedByDataQuality).toBe(8);
    expect(summary.signalsSaved).toBe(12);
    expect(summary.strategies.length).toBeGreaterThan(0);

    const bb = summary.strategies.find((s) => s.strategy === 'bullish_breakout');
    expect(bb?.evaluated).toBe(2);
    expect(bb?.matched).toBe(1);
    expect(bb?.confirmed).toBe(1);
    expect(bb?.averageFinalScore).toBe(82);
    expect(bb?.topRejectionReason).toContain('RSI');
  });

  it('snapshot omits strategies with zero activity', () => {
    const rows = snapshotStrategyScanHistogram();
    expect(rows).toEqual([]);
  });
});
