// ════════════════════════════════════════════════════════════════
//  Strategy Hub Portfolio — alert generation (Phase 8)
// ════════════════════════════════════════════════════════════════

import { upsertPortfolioAlert } from '../repository/portfolioAlerts';
import type { PortfolioRiskDashboard, StrategyAllocationRow } from './types';

export async function generatePortfolioAlerts(
  risk: PortfolioRiskDashboard,
  allocations: StrategyAllocationRow[],
  totalCapital: number,
  allocatedCapital: number,
): Promise<number> {
  let created = 0;

  if (allocatedCapital > totalCapital) {
    await upsertPortfolioAlert({
      alertKey: 'portfolio:over_allocation',
      type: 'over_allocation',
      severity: 'critical',
      title: 'Portfolio over-allocated',
      description: `Allocated capital ${allocatedCapital.toFixed(0)} exceeds total ${totalCapital.toFixed(0)}.`,
      suggestedAction: 'Reduce allocations until total allocated ≤ total capital.',
    });
    created += 1;
  }

  if (allocatedCapital >= totalCapital * 0.95) {
    await upsertPortfolioAlert({
      alertKey: 'portfolio:capital_exhaustion',
      type: 'capital_exhaustion',
      severity: 'warning',
      title: 'Capital nearly exhausted',
      description: `${((allocatedCapital / totalCapital) * 100).toFixed(1)}% of capital is allocated.`,
      suggestedAction: 'Reserve capital for new opportunities or reduce existing allocations.',
    });
    created += 1;
  }

  const top = allocations.filter((a) => a.isActive).sort((a, b) => b.allocatedPct - a.allocatedPct)[0];
  if (top && top.allocatedPct >= 45) {
    await upsertPortfolioAlert({
      alertKey: `portfolio:concentration:${top.strategyId}`,
      type: 'excessive_exposure',
      severity: top.allocatedPct >= 55 ? 'critical' : 'warning',
      strategyId: top.strategyId,
      title: `Excessive exposure to ${top.strategyName}`,
      description: `${top.strategyName} holds ${top.allocatedPct.toFixed(1)}% of allocated capital.`,
      suggestedAction: 'Rebalance toward other strategies to reduce concentration risk.',
    });
    created += 1;
  }

  for (const pair of risk.correlationRisk.highCorrelationPairs.slice(0, 3)) {
    await upsertPortfolioAlert({
      alertKey: `portfolio:corr:${pair.a}:${pair.b}`,
      type: 'high_correlation',
      severity: 'warning',
      title: `High correlation: ${pair.a} ↔ ${pair.b}`,
      description: `Pearson correlation ${pair.correlation} — strategies may move together.`,
      suggestedAction: 'Consider diversifying into uncorrelated strategies.',
    });
    created += 1;
  }

  if (risk.riskScore >= 60) {
    await upsertPortfolioAlert({
      alertKey: 'portfolio:risk_threshold',
      type: 'risk_threshold',
      severity: risk.riskScore >= 75 ? 'critical' : 'warning',
      title: 'Portfolio risk threshold exceeded',
      description: `Portfolio risk score is ${risk.riskScore}/100 (${risk.riskCategory}).`,
      suggestedAction: 'Review risk dashboard and reduce high-risk allocations.',
    });
    created += 1;
  }

  if (risk.maxDrawdownPct >= 15) {
    await upsertPortfolioAlert({
      alertKey: 'portfolio:drawdown',
      type: 'portfolio_drawdown',
      severity: risk.maxDrawdownPct >= 20 ? 'critical' : 'warning',
      title: 'Portfolio drawdown elevated',
      description: `Maximum strategy drawdown in the book is ${risk.maxDrawdownPct}%.`,
      suggestedAction: 'Reduce exposure to underperforming strategies or tighten risk limits.',
    });
    created += 1;
  }

  const active = allocations.filter((a) => a.isActive);
  if (active.length >= 3) {
    const pcts = active.map((a) => a.allocatedPct);
    const max = Math.max(...pcts);
    const min = Math.min(...pcts.filter((p) => p > 0));
    if (max > 0 && min > 0 && max / min >= 5) {
      await upsertPortfolioAlert({
        alertKey: 'portfolio:imbalance',
        type: 'allocation_imbalance',
        severity: 'info',
        title: 'Allocation imbalance detected',
        description: `Largest allocation is ${max.toFixed(1)}% vs smallest active ${min.toFixed(1)}%.`,
        suggestedAction: 'Consider rebalancing toward a more even distribution.',
      });
      created += 1;
    }
  }

  return created;
}
