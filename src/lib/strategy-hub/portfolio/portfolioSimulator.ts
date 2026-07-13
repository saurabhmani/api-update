// ════════════════════════════════════════════════════════════════
//  Strategy Hub Portfolio — simulation (Phase 8, read-only)
// ════════════════════════════════════════════════════════════════

import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import type { PortfolioSimulationParams, PortfolioSimulationResult, PortfolioWindow, StrategyPortfolioContext } from './types';
import { buildPortfolioKPIs } from './portfolioMetrics';
import { buildPortfolioRiskDashboard } from './portfolioRiskEngine';
import { round2 } from './portfolioMath';

export function simulatePortfolioChanges(
  window: PortfolioWindow,
  contexts: StrategyPortfolioContext[],
  outcomesByStrategy: Map<string, PerformanceOutcomeRow[]>,
  params: PortfolioSimulationParams,
  baselineTotalCapital: number,
): PortfolioSimulationResult {
  const simCapital = params.totalCapital ?? baselineTotalCapital;

  const baselineContexts = contexts.map((c) => ({ ...c }));
  const simContexts = contexts.map((c) => ({ ...c }));

  if (params.removeStrategies?.length) {
    for (const id of params.removeStrategies) {
      const ctx = simContexts.find((c) => c.strategyId === id);
      if (ctx) {
        ctx.allocatedAmount = 0;
        ctx.allocatedPct = 0;
      }
    }
  }

  if (params.addStrategies?.length) {
    for (const id of params.addStrategies) {
      const ctx = simContexts.find((c) => c.strategyId === id);
      if (ctx && ctx.allocatedAmount === 0) {
        const share = simCapital / Math.max(params.addStrategies.length, 1);
        ctx.allocatedAmount = round2(share);
        ctx.allocatedPct = round2((share / simCapital) * 100);
      }
    }
  }

  if (params.allocations?.length) {
    for (const a of params.allocations) {
      const ctx = simContexts.find((c) => c.strategyId === a.strategyId);
      if (!ctx) continue;
      if (a.amount != null) {
        ctx.allocatedAmount = a.amount;
        ctx.allocatedPct = simCapital > 0 ? round2((a.amount / simCapital) * 100) : 0;
      } else if (a.pct != null) {
        ctx.allocatedPct = a.pct;
        ctx.allocatedAmount = round2((a.pct / 100) * simCapital);
      }
    }
  }

  if (params.regimeFilter) {
    for (const ctx of simContexts) {
      const rows = outcomesByStrategy.get(ctx.strategyId) ?? [];
      const filtered = rows.filter(
        (r) => String(r.regime ?? '').toLowerCase() === params.regimeFilter!.toLowerCase(),
      );
      outcomesByStrategy.set(`${ctx.strategyId}:sim`, filtered);
    }
  }

  const baselineAllocated = baselineContexts.reduce((a, c) => a + c.allocatedAmount, 0);
  const simAllocated = simContexts.reduce((a, c) => a + c.allocatedAmount, 0);

  const baselineKpis = buildPortfolioKPIs(baselineContexts, outcomesByStrategy, baselineTotalCapital, baselineAllocated, window);
  const simKpis = buildPortfolioKPIs(simContexts, outcomesByStrategy, simCapital, simAllocated, window);
  const baselineRisk = buildPortfolioRiskDashboard(baselineContexts, outcomesByStrategy, baselineTotalCapital);
  const simRisk = buildPortfolioRiskDashboard(simContexts, outcomesByStrategy, simCapital);

  const notes = [
    'Simulation replays historical outcomes under hypothetical allocations — production data is unchanged.',
    `Capital: ${round2(simCapital)} (${params.totalCapital ? 'modified' : 'baseline'}).`,
  ];
  if (params.regimeFilter) notes.push(`Regime filter applied: ${params.regimeFilter}.`);

  return {
    window,
    params,
    baseline: {
      returnPct: baselineKpis.portfolioReturnPct,
      drawdownPct: baselineKpis.portfolioDrawdownPct,
      winRate: baselineKpis.portfolioWinRate,
      sharpe: baselineKpis.portfolioSharpe,
      riskScore: baselineRisk.riskScore,
      capitalUtilizationPct: baselineTotalCapital > 0 ? round2((baselineAllocated / baselineTotalCapital) * 100) : 0,
    },
    projected: {
      returnPct: simKpis.portfolioReturnPct,
      drawdownPct: simKpis.portfolioDrawdownPct,
      winRate: simKpis.portfolioWinRate,
      sharpe: simKpis.portfolioSharpe,
      riskScore: simRisk.riskScore,
      capitalUtilizationPct: simCapital > 0 ? round2((simAllocated / simCapital) * 100) : 0,
    },
    delta: {
      returnPct: round2(simKpis.portfolioReturnPct - baselineKpis.portfolioReturnPct),
      drawdownPct: round2(simKpis.portfolioDrawdownPct - baselineKpis.portfolioDrawdownPct),
      winRate: round2(simKpis.portfolioWinRate - baselineKpis.portfolioWinRate),
      riskScore: simRisk.riskScore - baselineRisk.riskScore,
    },
    notes,
    productionUnchanged: true,
  };
}
