// ════════════════════════════════════════════════════════════════
//  Strategy Hub Portfolio — risk dashboard (Phase 8)
// ════════════════════════════════════════════════════════════════

import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import type { PortfolioRiskDashboard, StrategyPortfolioContext } from './types';
import {
  diversificationScoreFromHhi,
  herfindahlIndex,
  historicalVar95,
  pearsonCorrelation,
  round2,
  strategyReturnSeries,
} from './portfolioMath';

function riskCategory(score: number): PortfolioRiskDashboard['riskCategory'] {
  if (score >= 70) return 'high';
  if (score >= 50) return 'elevated';
  if (score >= 30) return 'moderate';
  return 'low';
}

export function buildPortfolioRiskDashboard(
  contexts: StrategyPortfolioContext[],
  outcomesByStrategy: Map<string, PerformanceOutcomeRow[]>,
  totalCapital: number,
): PortfolioRiskDashboard {
  const active = contexts.filter((c) => c.allocatedAmount > 0);
  const weights = active.map((c) => c.allocatedPct || (totalCapital > 0 ? (c.allocatedAmount / totalCapital) * 100 : 0));
  const hhi = herfindahlIndex(weights);
  const divScore = diversificationScoreFromHhi(hhi, active.length);

  const strategyConcentration = active
    .map((c) => ({
      strategyId: c.strategyId,
      strategyName: c.strategyName,
      weightPct: round2(c.allocatedPct || (totalCapital > 0 ? (c.allocatedAmount / totalCapital) * 100 : 0)),
    }))
    .sort((a, b) => b.weightPct - a.weightPct);

  const sectorMap = new Map<string, { weight: number; trades: number }>();
  const regimeMap = new Map<string, number>();
  const dailyReturns: number[] = [];

  for (const ctx of active) {
    const rows = outcomesByStrategy.get(ctx.strategyId) ?? [];
    const w = ctx.allocatedPct / 100;
    for (const row of rows) {
      const sector = String(row.sector ?? 'Unknown');
      const regime = String(row.regime ?? 'Unknown');
      const cur = sectorMap.get(sector) ?? { weight: 0, trades: 0 };
      cur.weight += w;
      cur.trades += 1;
      sectorMap.set(sector, cur);
      regimeMap.set(regime, (regimeMap.get(regime) ?? 0) + w);
      if (row.returnPct != null) dailyReturns.push((row.returnPct ?? 0) * w);
    }
  }

  const sectorExposure = Array.from(sectorMap.entries())
    .map(([sector, v]) => ({ sector, weightPct: round2(v.weight * 100 / Math.max(active.length, 1)), trades: v.trades }))
    .sort((a, b) => b.weightPct - a.weightPct);

  const regimeExposure = Array.from(regimeMap.entries())
    .map(([regime, w]) => ({ regime, weightPct: round2((w / Math.max(active.length, 1)) * 100) }))
    .sort((a, b) => b.weightPct - a.weightPct);

  const highCorrelationPairs: Array<{ a: string; b: string; correlation: number }> = [];
  const ids = active.map((c) => c.strategyId);
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = strategyReturnSeries(outcomesByStrategy.get(ids[i]) ?? []);
      const b = strategyReturnSeries(outcomesByStrategy.get(ids[j]) ?? []);
      const corr = pearsonCorrelation(a, b);
      if (corr != null && Math.abs(corr) >= 0.6) {
        highCorrelationPairs.push({
          a: active[i].strategyName,
          b: active[j].strategyName,
          correlation: corr,
        });
      }
    }
  }

  const avgCorr = highCorrelationPairs.length
    ? round2(highCorrelationPairs.reduce((s, p) => s + Math.abs(p.correlation), 0) / highCorrelationPairs.length)
    : null;

  const maxConc = strategyConcentration[0]?.weightPct ?? 0;
  const maxSector = sectorExposure[0]?.weightPct ?? 0;
  const maxDd = Math.max(...active.map((c) => c.maxDrawdownPct), 0);

  const factors: PortfolioRiskDashboard['factors'] = [];
  const warnings: string[] = [];
  let riskScore = 0;

  if (maxConc >= 40) {
    riskScore += 25;
    factors.push({
      id: 'concentration',
      label: 'Strategy concentration',
      severity: maxConc >= 50 ? 'critical' : 'warning',
      value: maxConc,
      threshold: 40,
      detail: `${strategyConcentration[0]?.strategyName} holds ${maxConc}% of allocated capital.`,
    });
    warnings.push(`Excessive concentration in ${strategyConcentration[0]?.strategyName} (${maxConc}%).`);
  }

  if (highCorrelationPairs.length >= 2) {
    riskScore += 15;
    factors.push({
      id: 'correlation',
      label: 'High strategy correlation',
      severity: 'warning',
      value: highCorrelationPairs.length,
      threshold: 2,
      detail: `${highCorrelationPairs.length} strategy pairs show |correlation| ≥ 0.6.`,
    });
    warnings.push('Multiple strategy pairs are highly correlated.');
  }

  if (maxDd >= 12) {
    riskScore += 20;
    factors.push({
      id: 'drawdown',
      label: 'Portfolio drawdown',
      severity: maxDd >= 18 ? 'critical' : 'warning',
      value: maxDd,
      threshold: 12,
      detail: `Worst strategy drawdown in the book is ${maxDd}%.`,
    });
    warnings.push(`Drawdown risk elevated (max ${maxDd}%).`);
  }

  if (maxSector >= 50) {
    riskScore += 12;
    factors.push({
      id: 'sector',
      label: 'Sector exposure',
      severity: 'warning',
      value: maxSector,
      threshold: 50,
      detail: `${sectorExposure[0]?.sector} sector represents ${maxSector}% of weighted exposure.`,
    });
  }

  const allocated = active.reduce((a, c) => a + c.allocatedAmount, 0);
  if (allocated > totalCapital) {
    riskScore += 30;
    factors.push({
      id: 'over_allocation',
      label: 'Over-allocation',
      severity: 'critical',
      value: round2(allocated),
      threshold: totalCapital,
      detail: `Allocated ${round2(allocated)} exceeds total capital ${round2(totalCapital)}.`,
    });
    warnings.push('Portfolio is over-allocated.');
  }

  const liquidityRisk: PortfolioRiskDashboard['liquidityRisk'] =
    active.length < 3 ? 'high' : active.length < 5 ? 'medium' : 'low';

  return {
    riskScore: Math.min(100, riskScore),
    riskCategory: riskCategory(Math.min(100, riskScore)),
    portfolioVar95Pct: historicalVar95(dailyReturns),
    maxDrawdownPct: round2(maxDd),
    sectorExposure,
    strategyConcentration,
    correlationRisk: { averageCorrelation: avgCorr, highCorrelationPairs },
    liquidityRisk,
    regimeExposure,
    diversificationScore: divScore,
    factors,
    warnings,
  };
}
