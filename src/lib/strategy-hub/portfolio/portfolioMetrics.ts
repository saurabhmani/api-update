// ════════════════════════════════════════════════════════════════
//  Strategy Hub Portfolio — KPI aggregation (Phase 8)
// ════════════════════════════════════════════════════════════════

import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import { computeRiskAdjustedFromReturns, computeCagrFromReturns, windowDaysForAnalytics } from '../analytics/riskMetrics';
import type { PortfolioKPIs, PortfolioWindow, StrategyPortfolioContext } from './types';
import {
  computeMaxDrawdown,
  computeProfitFactor,
  computeWinRate,
  evaluatedRows,
  round2,
  strategyReturnSeries,
  weightedPortfolioReturn,
} from './portfolioMath';

export function buildPortfolioKPIs(
  contexts: StrategyPortfolioContext[],
  outcomesByStrategy: Map<string, PerformanceOutcomeRow[]>,
  totalCapital: number,
  allocatedCapital: number,
  window: PortfolioWindow,
): PortfolioKPIs {
  const active = contexts.filter((c) => c.allocatedAmount > 0 && c.deploymentStatus !== 'disabled');
  const live = contexts.filter((c) => c.environment === 'live');
  const paper = contexts.filter((c) => c.environment === 'paper');

  const weighted: Array<{ weightPct: number; returnPct: number }> = [];
  const allReturns: number[] = [];
  let totalTrades = 0;
  let portfolioEquity = 0;
  let peak = 0;
  let maxDd = 0;

  for (const ctx of active) {
    const rows = outcomesByStrategy.get(ctx.strategyId) ?? [];
    const ev = evaluatedRows(rows);
    totalTrades += ev.length;
    const stratReturn = ev.reduce((a, r) => a + (r.returnPct ?? 0), 0);
    const weight = ctx.allocatedPct > 0 ? ctx.allocatedPct : (allocatedCapital > 0 ? (ctx.allocatedAmount / allocatedCapital) * 100 : 0);
    weighted.push({ weightPct: weight, returnPct: stratReturn });
    const series = strategyReturnSeries(rows);
    for (const r of series) {
      const contrib = r * (weight / 100);
      allReturns.push(contrib);
      portfolioEquity += contrib;
      if (portfolioEquity > peak) peak = portfolioEquity;
      const dd = peak - portfolioEquity;
      if (dd > maxDd) maxDd = dd;
    }
  }

  const portfolioReturnPct = weightedPortfolioReturn(weighted);
  const combinedRows: PerformanceOutcomeRow[] = [];
  for (const ctx of active) {
    const rows = outcomesByStrategy.get(ctx.strategyId) ?? [];
    combinedRows.push(...rows);
  }

  const { sharpeRatio, sortinoRatio } = computeRiskAdjustedFromReturns(allReturns);
  const cagr = computeCagrFromReturns(allReturns, windowDaysForAnalytics(window));

  const riskScores = active.map((c) => c.aiRiskScore);
  const portfolioRiskScore = riskScores.length
    ? Math.round(riskScores.reduce((a, b) => a + b, 0) / riskScores.length)
    : 0;

  let dataStatus: PortfolioKPIs['dataStatus'] = 'INSUFFICIENT';
  if (totalTrades >= 20) dataStatus = 'SUFFICIENT';
  else if (totalTrades >= 5) dataStatus = 'LIMITED';

  return {
    totalCapital: round2(totalCapital),
    allocatedCapital: round2(allocatedCapital),
    availableCapital: round2(Math.max(0, totalCapital - allocatedCapital)),
    activeStrategies: active.length,
    liveStrategies: live.length,
    paperStrategies: paper.length,
    portfolioReturnPct,
    portfolioCagrPct: cagr,
    portfolioSharpe: sharpeRatio,
    portfolioSortino: sortinoRatio,
    portfolioProfitFactor: computeProfitFactor(combinedRows),
    portfolioDrawdownPct: round2(maxDd || computeMaxDrawdown(combinedRows)),
    portfolioWinRate: computeWinRate(combinedRows),
    portfolioRiskScore,
    evaluatedTrades: totalTrades,
    dataStatus,
  };
}
