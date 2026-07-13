import { describe, it, expect } from 'vitest';
import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import { linearTrend, computeSimulationMetrics, clamp } from './aiMath';
import { buildAiPrediction } from './predictiveEngine';
import { buildRiskAssessment } from './riskEngine';
import { detectAnomalies } from './anomalyDetector';
import { buildAiRecommendations } from './advisorEngine';
import { simulateStrategyChanges } from './optimizationSimulator';
import { buildExecutiveSummary } from './executiveSummaryBuilder';
import type { TrendAnalytics } from '../analytics/types';

function row(partial: Partial<PerformanceOutcomeRow> & { strategyId: string }): PerformanceOutcomeRow {
  return {
    symbol: 'RELIANCE',
    direction: 'BUY',
    sector: 'Conglomerate',
    regime: 'Bullish',
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

describe('aiMath', () => {
  it('computes linear trend slope', () => {
    const trend = linearTrend([40, 45, 50, 55, 60]);
    expect(trend.slope).toBeGreaterThan(0);
    expect(trend.next).toBeGreaterThan(60);
  });

  it('clamps values', () => {
    expect(clamp(150, 0, 100)).toBe(100);
    expect(clamp(-5, 0, 100)).toBe(0);
  });

  it('computes simulation metrics from rows', () => {
    const rows = [
      row({ strategyId: 's1', outcome: 'WIN', returnPct: 3 }),
      row({ strategyId: 's1', outcome: 'LOSS', returnPct: -2, signalRef: 'sig-2' }),
      row({ strategyId: 's1', outcome: 'WIN', returnPct: 1.5, signalRef: 'sig-3' }),
    ];
    const m = computeSimulationMetrics(rows);
    expect(m.trades).toBe(3);
    expect(m.winRate).toBeGreaterThan(0);
  });
});

describe('predictiveEngine', () => {
  const trends: TrendAnalytics = {
    granularity: 'weekly',
    points: [
      { period: 'W1', winRate: 45, drawdownPct: 5, returnPct: 1, signalQuality: 60, approvalRate: 50, averageConfidence: 65, trades: 5 },
      { period: 'W2', winRate: 50, drawdownPct: 4, returnPct: 1.5, signalQuality: 62, approvalRate: 52, averageConfidence: 66, trades: 6 },
      { period: 'W3', winRate: 55, drawdownPct: 3, returnPct: 2, signalQuality: 65, approvalRate: 55, averageConfidence: 68, trades: 7 },
      { period: 'W4', winRate: 60, drawdownPct: 2, returnPct: 2.5, signalQuality: 68, approvalRate: 58, averageConfidence: 70, trades: 8 },
    ],
  };

  it('classifies improving trend', () => {
    const pred = buildAiPrediction('s1', trends, {
      strategyId: 's1',
      strategyName: 'Test',
      winRate: 58,
      profitFactor: 1.5,
      maxDrawdownPct: 5,
      sharpeRatio: 1.2,
      averageConfidence: 68,
      evaluatedSignals: 26,
    } as never, '90D');
    expect(pred.trend).toBe('improving');
    expect(pred.expectedWinRate).toBeGreaterThan(50);
    expect(pred.reliable).toBe(true);
  });

  it('falls back when no trend data', () => {
    const pred = buildAiPrediction('s1', null, null, '90D');
    expect(pred.trend).toBe('stable');
    expect(pred.reliable).toBe(false);
  });
});

describe('riskEngine', () => {
  it('scores high drawdown as elevated risk', () => {
    const pred = buildAiPrediction('s1', null, null, '90D');
    const risk = buildRiskAssessment({
      strategyId: 's1',
      summary: {
        evaluatedSignals: 20,
        maxDrawdownPct: 18,
        winRate: 40,
        signalQualityScore: 35,
        approvalRate: 20,
      } as never,
      prediction: pred,
      regime: null,
      confidence: null,
      allowedRegimes: ['Bullish'],
      window: '90D',
      backtestShare: 0.2,
    });
    expect(risk.riskScore).toBeGreaterThan(20);
    expect(risk.drawdownProbability).toBe('high');
    expect(risk.factors.length).toBeGreaterThan(0);
  });
});

describe('anomalyDetector', () => {
  it('detects win rate drop between recent and baseline', () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const rows: PerformanceOutcomeRow[] = [];
    for (let i = 0; i < 8; i += 1) {
      rows.push(row({
        strategyId: 's1',
        outcome: 'WIN',
        returnPct: 2,
        evaluatedAt: old,
        signalRef: `old-${i}`,
        signalId: i,
      }));
    }
    for (let i = 0; i < 5; i += 1) {
      rows.push(row({
        strategyId: 's1',
        outcome: 'LOSS',
        returnPct: -3,
        evaluatedAt: recent,
        signalRef: `new-${i}`,
        signalId: 100 + i,
      }));
    }

    const anomalies = detectAnomalies('s1', rows, { window: '90D' });
    expect(anomalies.some((a) => a.type === 'win_rate_drop')).toBe(true);
  });
});

describe('advisorEngine', () => {
  it('recommends regime restriction when worst regime underperforms', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => row({
        strategyId: 's1',
        regime: 'Bullish',
        outcome: 'WIN',
        returnPct: 2,
        signalRef: `b-${i}`,
        signalId: i,
      })),
      ...Array.from({ length: 5 }, (_, i) => row({
        strategyId: 's1',
        regime: 'Bearish',
        outcome: 'LOSS',
        returnPct: -3,
        signalRef: `br-${i}`,
        signalId: 100 + i,
      })),
    ];

    const pred = buildAiPrediction('s1', null, {
      strategyId: 's1',
      strategyName: 'Test',
      winRate: 55,
      profitFactor: 1.3,
      maxDrawdownPct: 6,
      evaluatedSignals: 11,
      healthLabel: 'STABLE',
    } as never, '90D');

    const risk = buildRiskAssessment({
      strategyId: 's1',
      summary: { evaluatedSignals: 11, maxDrawdownPct: 6, winRate: 55, signalQualityScore: 60, approvalRate: 50 } as never,
      prediction: pred,
      regime: {
        dataStatus: 'AVAILABLE',
        rows: [],
        bestRegime: null,
        worstRegime: { regime: 'Bearish', trades: 5, winRate: 20, averageReturnPct: -2.5, averageConfidence: 60, drawdownPct: 8, profitFactor: 0.5, expectancy: -1 },
        recommendedRegimes: [],
      },
      confidence: null,
      allowedRegimes: ['Bullish', 'Bearish'],
      window: '90D',
      backtestShare: 0,
    });

    const recs = buildAiRecommendations({
      strategyId: 's1',
      strategyName: 'Test Strategy',
      window: '90D',
      rows,
      summary: { evaluatedSignals: 11, winRate: 55, profitFactor: 1.3, maxDrawdownPct: 6, healthLabel: 'STABLE', averageConfidence: 65, approvalRate: 50, signalQualityScore: 60 } as never,
      regime: {
        dataStatus: 'AVAILABLE',
        rows: [],
        bestRegime: { regime: 'Bullish', trades: 6, winRate: 80, averageReturnPct: 2, averageConfidence: 70, drawdownPct: 2, profitFactor: 2, expectancy: 1.5 },
        worstRegime: { regime: 'Bearish', trades: 5, winRate: 20, averageReturnPct: -2.5, averageConfidence: 60, drawdownPct: 8, profitFactor: 0.5, expectancy: -1 },
        recommendedRegimes: ['Bullish'],
      },
      confidence: null,
      learning: null,
      prediction: pred,
      risk,
      anomalies: [],
      currentMode: 'CONFIRMED_ENABLED',
      deploymentStatus: 'draft',
      paperTradingEnabled: false,
      latestValidation: null,
      allowedRegimes: ['Bullish', 'Bearish'],
      riskProfile: 'moderate',
    });

    expect(recs.some((r) => r.category === 'regime')).toBe(true);
    expect(recs.every((r) => r.evidence.length > 0)).toBe(true);
  });
});

describe('optimizationSimulator', () => {
  it('never modifies production and reports delta', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row({
      strategyId: 's1',
      confidenceScore: i < 5 ? 80 : 50,
      outcome: i < 6 ? 'WIN' : 'LOSS',
      returnPct: i < 6 ? 2 : -1.5,
      signalRef: `sim-${i}`,
      signalId: i,
    }));

    const result = simulateStrategyChanges('s1', rows, { minConfidence: 70 }, '90D');
    expect(result.productionUnchanged).toBe(true);
    expect(result.simulated.trades).toBeLessThanOrEqual(result.baseline.trades);
    expect(result.notes.length).toBeGreaterThan(0);
  });
});

describe('executiveSummaryBuilder', () => {
  it('builds hub-level summary from snapshots', () => {
    const pred = buildAiPrediction('s1', null, null, '90D');
    const risk = buildRiskAssessment({
      strategyId: 's1',
      summary: { evaluatedSignals: 20, maxDrawdownPct: 5, winRate: 60, signalQualityScore: 70, approvalRate: 55 } as never,
      prediction: pred,
      regime: null,
      confidence: null,
      allowedRegimes: null,
      window: '30D',
      backtestShare: 0,
    });

    const summary = buildExecutiveSummary([
      {
        strategyId: 's1',
        strategyName: 'Strong Strategy',
        winRate: 62,
        profitFactor: 1.8,
        maxDrawdownPct: 4,
        evaluatedSignals: 25,
        healthLabel: 'STRONG',
        prediction: pred,
        risk,
        recommendations: [],
        anomalies: [],
        validationStatus: 'ready',
      },
    ], { period: 'weekly', window: '30D', openAlerts: 2 });

    expect(summary.headline).toContain('Weekly review');
    expect(summary.totals.strategiesAnalyzed).toBe(1);
    expect(summary.bestPerformers.length).toBeGreaterThan(0);
  });
});
