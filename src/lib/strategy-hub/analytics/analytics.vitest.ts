import { describe, it, expect } from 'vitest';
import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import {
  buildRegimeAnalytics,
  buildConfidenceDistribution,
  buildExtendedRanking,
  computeExtendedMetrics,
  buildComparativeAnalysis,
} from './analyticsBuilders';
import { computeRiskAdjustedFromReturns, computeConsistencyScore } from './riskMetrics';
import { analyticsCacheKey, getAnalyticsCache, setAnalyticsCache, invalidateAnalyticsCache } from './analyticsCache';
import type { StrategyPerformance } from '@/lib/strategies/strategyPerformance';

function row(partial: Partial<PerformanceOutcomeRow> & { strategyId: string }): PerformanceOutcomeRow {
  return {
    symbol: 'RELIANCE',
    direction: 'BUY',
    sector: 'Conglomerate',
    regime: 'bullish',
    confidenceScore: 72,
    outcome: 'WIN',
    returnPct: 2.5,
    returnR: 1.2,
    targetHit: true,
    stopHit: false,
    invalidated: false,
    mfePct: 3,
    maePct: -1,
    holdingPeriodBars: 5,
    approvalStatus: 'APPROVED',
    evaluatedAt: '2026-01-15T10:00:00.000Z',
    source: 'direct',
    outcomeSource: 'direct',
    signalRef: 'sig-1',
    signalId: 1,
    ...partial,
  };
}

describe('analytics risk metrics', () => {
  it('computes sharpe from return series', () => {
    const returns = [2, -1, 3, 1.5, -0.5, 2, 1, -1.5, 2.5, 0.5];
    const { sharpeRatio, sortinoRatio } = computeRiskAdjustedFromReturns(returns);
    expect(sharpeRatio).not.toBeNull();
    expect(sortinoRatio).not.toBeNull();
  });

  it('returns null sharpe for insufficient data', () => {
    expect(computeRiskAdjustedFromReturns([1, 2]).sharpeRatio).toBeNull();
  });

  it('scores higher consistency for stable returns', () => {
    const stable = computeConsistencyScore([1, 1.1, 0.9, 1.05, 0.95]);
    const volatile = computeConsistencyScore([5, -4, 8, -6, 3]);
    expect(stable).toBeGreaterThan(volatile);
  });
});

describe('analytics builders', () => {
  const rows = [
    row({ strategyId: 'bullish_breakout', regime: 'bullish', outcome: 'WIN', returnPct: 3 }),
    row({ strategyId: 'bullish_breakout', regime: 'bullish', outcome: 'LOSS', returnPct: -2, signalRef: 'sig-2', signalId: 2 }),
    row({ strategyId: 'bullish_breakout', regime: 'bearish', outcome: 'WIN', returnPct: 1.5, signalRef: 'sig-3', signalId: 3 }),
    row({ strategyId: 'bullish_breakout', regime: 'bearish', outcome: 'LOSS', returnPct: -3, signalRef: 'sig-4', signalId: 4 }),
    row({ strategyId: 'bullish_breakout', regime: 'sideways', outcome: 'WIN', returnPct: 0.8, signalRef: 'sig-5', signalId: 5 }),
  ];

  it('builds regime analytics with best/worst', () => {
    const regime = buildRegimeAnalytics(rows);
    expect(regime.dataStatus).toBe('AVAILABLE');
    expect(regime.rows.length).toBeGreaterThan(0);
    // bestRegime requires >= 3 trades per regime bucket
    if (regime.rows.some((r) => r.trades >= 3)) {
      expect(regime.bestRegime).not.toBeNull();
    }
  });

  it('builds confidence distribution histogram', () => {
    const dist = buildConfidenceDistribution(rows);
    expect(dist.histogram.length).toBe(5);
    expect(dist.average).not.toBeNull();
  });

  it('computes extended metrics', () => {
    const perf = {
      strategyId: 'bullish_breakout',
      approvalAccuracy: 60,
      winRate: 60,
      profitFactor: 1.5,
    } as StrategyPerformance;
    const ext = computeExtendedMetrics(rows, '90D', perf);
    expect(ext.approvalRate).toBeGreaterThan(0);
    expect(ext.signalQualityScore).toBeGreaterThan(0);
  });
});

describe('analytics cache', () => {
  it('stores and retrieves cached payloads', () => {
    invalidateAnalyticsCache();
    const key = analyticsCacheKey({ ns: 'test', id: 'a' });
    setAnalyticsCache(key, { value: 42 }, 60_000);
    const hit = getAnalyticsCache<{ value: number }>(key);
    expect(hit?.value.value).toBe(42);
    invalidateAnalyticsCache();
  });
});
