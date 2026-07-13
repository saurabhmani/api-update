import { describe, it, expect } from 'vitest';
import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import {
  validateAllocations,
  computeAllocationsByMethod,
  normalizePctFromAmount,
} from './allocationEngine';
import { buildPortfolioKPIs } from './portfolioMetrics';
import { buildPortfolioRiskDashboard } from './portfolioRiskEngine';
import { buildDiversificationAnalysis } from './diversificationAnalyzer';
import { optimizePortfolioAllocation } from './portfolioOptimizer';
import { simulatePortfolioChanges } from './portfolioSimulator';
import {
  herfindahlIndex,
  diversificationScoreFromHhi,
} from './portfolioMath';
import type { StrategyPortfolioContext, StrategyAllocationRow } from './types';

function ctx(partial: Partial<StrategyPortfolioContext> & { strategyId: string }): StrategyPortfolioContext {
  return {
    strategyName: partial.strategyId.replace(/_/g, ' '),
    deploymentStatus: 'paper_deployed',
    environment: 'paper',
    allocatedAmount: 0,
    allocatedPct: 0,
    winRate: 55,
    profitFactor: 1.5,
    maxDrawdownPct: 5,
    sharpeRatio: 1.2,
    averageConfidence: 70,
    healthScore: 75,
    aiRiskScore: 30,
    validationScore: 80,
    evaluatedTrades: 20,
    category: 'momentum',
    riskProfile: 'moderate',
    ...partial,
  };
}

function row(partial: Partial<PerformanceOutcomeRow> & { strategyId: string }): PerformanceOutcomeRow {
  return {
    symbol: 'RELIANCE',
    direction: 'BUY',
    sector: 'Energy',
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

describe('allocationEngine', () => {
  const contexts = [
    ctx({ strategyId: 's1', aiRiskScore: 20, winRate: 60, allocatedAmount: 300000, allocatedPct: 30 }),
    ctx({ strategyId: 's2', aiRiskScore: 60, winRate: 45, allocatedAmount: 200000, allocatedPct: 20 }),
    ctx({ strategyId: 's3', deploymentStatus: 'draft', environment: 'none' }),
  ];

  it('rejects over-allocation', () => {
    const result = validateAllocations([
      { strategyId: 's1', amount: 600000, pct: 60 },
      { strategyId: 's2', amount: 500000, pct: 50 },
    ], 1000000);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects negative allocations', () => {
    const result = validateAllocations([{ strategyId: 's1', amount: -100, pct: -1 }], 1000000);
    expect(result.ok).toBe(false);
  });

  it('computes equal allocation', () => {
    const eligible = contexts.filter((c) => c.deploymentStatus === 'paper_deployed');
    const proposals = computeAllocationsByMethod('equal', eligible, 1000000);
    expect(proposals.length).toBe(2);
    expect(proposals[0].amount).toBe(500000);
  });

  it('computes risk-weighted allocation favoring low risk', () => {
    const eligible = contexts.filter((c) => c.deploymentStatus === 'paper_deployed');
    const proposals = computeAllocationsByMethod('risk_weighted', eligible, 1000000);
    const s1 = proposals.find((p) => p.strategyId === 's1');
    const s2 = proposals.find((p) => p.strategyId === 's2');
    expect(s1!.pct).toBeGreaterThan(s2!.pct);
  });

  it('normalizes pct from amount', () => {
    expect(normalizePctFromAmount(250000, 1000000)).toBe(25);
  });
});

describe('portfolioMath', () => {
  it('computes HHI and diversification score', () => {
    const hhi = herfindahlIndex([50, 30, 20]);
    const score = diversificationScoreFromHhi(hhi, 3);
    expect(hhi).toBeGreaterThan(0);
    expect(score).toBeGreaterThan(0);
  });
});

describe('portfolioMetrics', () => {
  it('builds KPIs from weighted contexts', () => {
    const contexts = [
      ctx({ strategyId: 's1', allocatedAmount: 500000, allocatedPct: 50 }),
      ctx({ strategyId: 's2', allocatedAmount: 300000, allocatedPct: 30 }),
    ];
    const outcomes = new Map<string, PerformanceOutcomeRow[]>([
      ['s1', [row({ strategyId: 's1', returnPct: 3 }), row({ strategyId: 's1', returnPct: -1, signalRef: 's2' })]],
      ['s2', [row({ strategyId: 's2', returnPct: 2, signalRef: 's3' })]],
    ]);
    const kpis = buildPortfolioKPIs(contexts, outcomes, 1000000, 800000, '90D');
    expect(kpis.totalCapital).toBe(1000000);
    expect(kpis.allocatedCapital).toBe(800000);
    expect(kpis.availableCapital).toBe(200000);
    expect(kpis.activeStrategies).toBe(2);
  });
});

describe('portfolioRiskEngine', () => {
  it('flags concentration risk', () => {
    const contexts = [
      ctx({ strategyId: 's1', allocatedAmount: 500000, allocatedPct: 50, strategyName: 'Big' }),
      ctx({ strategyId: 's2', allocatedAmount: 100000, allocatedPct: 10, strategyName: 'Small' }),
    ];
    const outcomes = new Map<string, PerformanceOutcomeRow[]>();
    const risk = buildPortfolioRiskDashboard(contexts, outcomes, 1000000);
    expect(risk.strategyConcentration[0].weightPct).toBe(50);
    expect(risk.warnings.length).toBeGreaterThan(0);
  });

  it('flags over-allocation', () => {
    const contexts = [
      ctx({ strategyId: 's1', allocatedAmount: 1100000, allocatedPct: 110 }),
    ];
    const risk = buildPortfolioRiskDashboard(contexts, new Map(), 1000000);
    expect(risk.riskScore).toBeGreaterThanOrEqual(30);
    expect(risk.factors.some((f) => f.id === 'over_allocation')).toBe(true);
  });
});

describe('portfolioOptimizer', () => {
  it('returns advisory optimization result', () => {
    const contexts = [
      ctx({ strategyId: 's1', allocatedAmount: 400000, allocatedPct: 40 }),
      ctx({ strategyId: 's2', allocatedAmount: 400000, allocatedPct: 40 }),
    ];
    const rows: StrategyAllocationRow[] = contexts.map((c) => ({
      strategyId: c.strategyId,
      strategyName: c.strategyName,
      deploymentStatus: c.deploymentStatus,
      environment: c.environment,
      allocationMethod: 'manual',
      allocatedAmount: c.allocatedAmount,
      allocatedPct: c.allocatedPct,
      suggestedAmount: null,
      suggestedPct: null,
      isActive: true,
      eligible: true,
    }));
    const result = optimizePortfolioAllocation('balanced', contexts, rows, 1000000);
    expect(result.advisoryOnly).toBe(true);
    expect(result.notes.some((n) => n.includes('advisory'))).toBe(true);
  });
});

describe('portfolioSimulator', () => {
  it('never modifies production', () => {
    const contexts = [ctx({ strategyId: 's1', allocatedAmount: 500000, allocatedPct: 50 })];
    const outcomes = new Map([['s1', [row({ strategyId: 's1' })]]]);
    const result = simulatePortfolioChanges('90D', contexts, outcomes, { totalCapital: 2000000 }, 1000000);
    expect(result.productionUnchanged).toBe(true);
    expect(result.projected.capitalUtilizationPct).toBeDefined();
  });
});

describe('diversificationAnalyzer', () => {
  it('builds sector buckets', () => {
    const contexts = [ctx({ strategyId: 's1', allocatedAmount: 500000, allocatedPct: 50 })];
    const outcomes = new Map([
      ['s1', [
        row({ strategyId: 's1', sector: 'Energy' }),
        row({ strategyId: 's1', sector: 'IT', signalRef: 's2' }),
      ]],
    ]);
    const analysis = buildDiversificationAnalysis(contexts, outcomes, new Map(), 1000000);
    expect(analysis.sector.length).toBeGreaterThan(0);
    expect(analysis.recommendations.length).toBeGreaterThan(0);
  });
});
