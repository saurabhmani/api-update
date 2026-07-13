import { describe, expect, it } from 'vitest';
import { evaluateOutcome } from '@/lib/signal-engine/feedback/outcomeTracker';
import { summarizeOutcomeIntelligence } from '@/lib/signal-engine/analytics/outcomeAnalytics';

describe('outcome intelligence', () => {
  it('tracks target timing, excursions, exit and version metadata', () => {
    const outcome = evaluateOutcome(
      101,
      100,
      95,
      107.5,
      112.5,
      117.5,
      [
        { ts: '2026-01-02', high: 103, low: 98, close: 102 },
        { ts: '2026-01-03', high: 108, low: 101, close: 107 },
        { ts: '2026-01-04', high: 113, low: 106, close: 112 },
        { ts: '2026-01-05', high: 118, low: 111, close: 117 },
        { ts: '2026-01-06', high: 119, low: 115, close: 118 },
      ],
      false,
      { expectedRewardRisk: 1.5, evaluatedAt: '2026-01-06T00:00:00Z' },
    );

    expect(outcome.target1Hit).toBe(true);
    expect(outcome.timeToTargetBars).toBe(1);
    expect(outcome.timeToStopBars).toBeNull();
    expect(outcome.exitReason).toBe('target3');
    expect(outcome.holdingDurationBars).toBe(4);
    expect(outcome.expectedRewardRisk).toBe(1.5);
    expect(outcome.realizedRewardRisk).toBe(3.5);
    expect(outcome.outcomeVersion).toBe('3.0.0');
    expect(outcome.evaluatedAt).toBe('2026-01-06 00:00:00');
  });

  it('uses direction-correct returns for bearish outcomes', () => {
    const candles = Array.from({ length: 10 }, (_, index) => ({
      ts: `2026-02-${String(index + 1).padStart(2, '0')}`,
      high: 100 - index,
      low: 98 - index,
      close: 99 - index,
    }));
    const outcome = evaluateOutcome(
      102, 100, 106, 94, 90, 86, candles, true,
      { evaluatedAt: '2026-02-10T00:00:00Z' },
    );
    expect(outcome.returnAtBar5Pct).toBeGreaterThan(0);
    expect(outcome.returnAtBar10Pct).toBeGreaterThan(0);
  });

  it('uses conservative stop precedence when target and stop share a candle', () => {
    const outcome = evaluateOutcome(
      104, 100, 95, 105, 110, 115,
      [{ ts: '2026-02-15', high: 106, low: 94, close: 101 }],
      false,
      { evaluatedAt: '2026-02-15T00:00:00Z' },
    );
    expect(outcome.exitReason).toBe('stop');
    expect(outcome.outcomeLabel).toBe('stopped_out');
    expect(outcome.pnlR).toBe(-1);
  });

  it('aggregates outcome intelligence deterministically', () => {
    const outcome = evaluateOutcome(
      103, 100, 95, 105, 110, 115,
      [{ ts: '2026-03-01', high: 106, low: 99, close: 105 }],
      false,
      { evaluatedAt: '2026-03-01T00:00:00Z' },
    );
    const records = [{
      signalId: 103,
      symbol: 'TEST',
      strategy: 'bullish_breakout',
      sector: 'IT',
      marketRegime: 'Bullish',
      timeframe: 'daily',
      generatedAt: '2026-02-28T00:00:00Z',
      predictedConfidence: 70,
      expectedRewardRisk: 1,
      outcome,
    }];
    expect(summarizeOutcomeIntelligence(records)).toEqual(summarizeOutcomeIntelligence(records));
    expect(summarizeOutcomeIntelligence(records).sampleCount).toBe(1);
  });
});
