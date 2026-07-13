import { describe, expect, it } from 'vitest';
import {
  buildProductAPerformanceReport,
  reportToCsv,
  reportToJson,
} from '@/lib/signal-engine/analytics/performanceReporting';
import type { OutcomeAnalyticsRecord } from '@/lib/signal-engine/analytics/outcomeAnalytics';
import { classifyHistoricalEnvironment } from '@/lib/signal-engine/analytics/regimeAndExplainabilityAnalytics';

function record(
  id: number,
  confidence: number,
  win: boolean,
  generatedAt: string,
  strategy = 'bullish_breakout',
): OutcomeAnalyticsRecord {
  return {
    signalId: id,
    symbol: `SYM${id}`,
    strategy,
    sector: id % 2 ? 'IT' : 'Finance',
    marketRegime: win ? 'Bullish' : 'Sideways',
    timeframe: 'daily',
    generatedAt,
    predictedConfidence: confidence,
    expectedRewardRisk: 1.5,
    topContributingFeatures: [
      { feature: 'trend_strength', score: win ? 80 : 35 },
      { feature: 'volume_quality', score: win ? 70 : 40 },
    ],
    outcome: {
      signalId: id,
      entryTriggered: true,
      barsToEntry: 0,
      target1Hit: win,
      target2Hit: false,
      target3Hit: false,
      stopHit: !win,
      maxFavorableExcursionPct: win ? 8 : 2,
      maxAdverseExcursionPct: win ? -1 : -5,
      pnlR: win ? 1.5 : -1,
      returnAtBar5Pct: win ? 4 : -3,
      returnAtBar10Pct: null,
      outcomeLabel: win ? 'partial_success' : 'stopped_out',
      evaluatedAt: '2026-02-01 00:00:00',
      exitReason: win ? 'target1' : 'stop',
      holdingDurationBars: win ? 4 : 2,
      realizedReturnPct: win ? 6 : -4,
      realizedRewardRisk: win ? 1.5 : -1,
    },
  };
}

const RECORDS = [
  record(1, 80, true, '2026-01-05T00:00:00Z'),
  record(2, 70, true, '2026-01-10T00:00:00Z'),
  record(3, 75, false, '2026-01-15T00:00:00Z', 'bullish_pullback'),
  record(4, 40, false, '2026-01-20T00:00:00Z', 'bullish_pullback'),
];

describe('performance reporting', () => {
  it('computes calibration, dimensions and drawdown', () => {
    const report = buildProductAPerformanceReport(RECORDS, {
      generatedAt: '2026-02-01T00:00:00Z',
    });
    expect(report.overall.sampleCount).toBe(4);
    expect(report.confidenceCalibration.brierScore).toBeGreaterThan(0);
    expect(report.strategyLeaderboard).toHaveLength(2);
    expect(report.performanceDimensions.week.length).toBeGreaterThan(0);
    expect(report.featureImportanceSummary[0].sampleCount).toBe(4);
  });

  it('exports valid JSON and stable CSV', () => {
    const report = buildProductAPerformanceReport(RECORDS, {
      generatedAt: '2026-02-01T00:00:00Z',
    });
    expect(JSON.parse(reportToJson(report)).reportVersion).toBe('3.0.0');
    const csv = reportToCsv(report);
    expect(csv).toContain('"section","dimension","key"');
    expect(csv).toContain('"confidence_calibration"');
  });

  it('is deterministic for identical inputs', () => {
    const options = { generatedAt: '2026-02-01T00:00:00Z' };
    expect(buildProductAPerformanceReport(RECORDS, options))
      .toEqual(buildProductAPerformanceReport(RECORDS, options));
  });

  it('classifies historical environments with explicit precedence', () => {
    expect(classifyHistoricalEnvironment({
      marketRegime: 'High Volatility Risk',
      manualTags: ['news-driven'],
    })).toBe('news_driven');
    expect(classifyHistoricalEnvironment({
      marketRegime: 'Sideways',
      gapPct: 3,
    })).toBe('gap_driven');
    expect(classifyHistoricalEnvironment({
      marketRegime: 'Sideways',
    })).toBe('range_bound');
  });
});
