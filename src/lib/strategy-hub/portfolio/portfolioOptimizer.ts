// ════════════════════════════════════════════════════════════════
//  Strategy Hub Portfolio — optimization (Phase 8, advisory only)
// ════════════════════════════════════════════════════════════════

import type {
  OptimizationGoal,
  PortfolioOptimizationResult,
  OptimizationRecommendation,
  StrategyAllocationRow,
  StrategyPortfolioContext,
} from './types';
import { computeAllocationsByMethod } from './allocationEngine';
import { round2 } from './portfolioMath';

function goalToMethod(goal: OptimizationGoal): 'risk_weighted' | 'performance_weighted' | 'confidence_weighted' | 'equal' {
  switch (goal) {
    case 'minimize_risk':
    case 'conservative':
      return 'risk_weighted';
    case 'maximize_return':
    case 'growth':
      return 'performance_weighted';
    case 'income':
      return 'confidence_weighted';
    default:
      return 'equal';
  }
}

export function optimizePortfolioAllocation(
  goal: OptimizationGoal,
  contexts: StrategyPortfolioContext[],
  currentRows: StrategyAllocationRow[],
  totalCapital: number,
): PortfolioOptimizationResult {
  const method = goalToMethod(goal);
  const proposals = computeAllocationsByMethod(method, contexts, totalCapital);
  const proposalMap = new Map(proposals.map((p) => [p.strategyId, p]));

  const recommendations: OptimizationRecommendation[] = currentRows
    .filter((r) => r.eligible)
    .map((row) => {
      const rec = proposalMap.get(row.strategyId);
      const recommendedPct = rec?.pct ?? 0;
      const delta = round2(recommendedPct - row.allocatedPct);
      let reason = `Optimized for ${goal.replace('_', ' ')} using ${method.replace('_', ' ')} weighting.`;
      const ctx = contexts.find((c) => c.strategyId === row.strategyId);
      if (ctx) {
        if (ctx.aiRiskScore >= 60) reason += ` Elevated AI risk score (${ctx.aiRiskScore}).`;
        if (ctx.validationScore != null && ctx.validationScore < 70) reason += ` Validation score ${ctx.validationScore}.`;
        if (ctx.winRate >= 55) reason += ` Strong win rate ${ctx.winRate}%.`;
      }
      const confidence: OptimizationRecommendation['confidence'] =
        ctx && ctx.evaluatedTrades >= 15 ? 'high' : ctx && ctx.evaluatedTrades >= 5 ? 'medium' : 'low';
      return {
        strategyId: row.strategyId,
        strategyName: row.strategyName,
        currentPct: row.allocatedPct,
        recommendedPct: round2(recommendedPct),
        deltaPct: delta,
        reason,
        confidence,
      };
    })
    .filter((r) => Math.abs(r.deltaPct) >= 1)
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));

  const currentReturn = contexts.reduce((a, c) => a + c.winRate * (c.allocatedPct / 100), 0);
  const projectedReturn = contexts.reduce((a, c) => {
    const rec = proposalMap.get(c.strategyId);
    return a + c.winRate * ((rec?.pct ?? 0) / 100);
  }, 0);

  const currentRisk = contexts.reduce((a, c) => a + c.aiRiskScore * (c.allocatedPct / 100), 0);
  const projectedRisk = contexts.reduce((a, c) => {
    const rec = proposalMap.get(c.strategyId);
    return a + c.aiRiskScore * ((rec?.pct ?? 0) / 100);
  }, 0);

  const notes = [
    'Optimization is advisory only — allocations are not applied automatically.',
    `Goal: ${goal}. Method: ${method}.`,
    `${recommendations.length} strategies would benefit from rebalancing.`,
  ];

  return {
    goal,
    currentAllocations: currentRows,
    recommendedAllocations: recommendations,
    expectedReturnImprovementPct: round2(projectedReturn - currentReturn),
    expectedRiskImpact: projectedRisk < currentRisk
      ? `Risk score may decrease by ~${round2(currentRisk - projectedRisk)} pts.`
      : projectedRisk > currentRisk
        ? `Risk score may increase by ~${round2(projectedRisk - currentRisk)} pts.`
        : 'Neutral risk impact expected.',
    expectedDrawdownChangePct: goal === 'minimize_risk' || goal === 'conservative' ? -2 : null,
    notes,
    advisoryOnly: true,
  };
}
