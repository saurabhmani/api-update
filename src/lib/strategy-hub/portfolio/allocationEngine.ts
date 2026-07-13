// ════════════════════════════════════════════════════════════════
//  Strategy Hub Portfolio — capital allocation engine (Phase 8)
// ════════════════════════════════════════════════════════════════

import type { AllocationMethod, StrategyAllocationRow } from './types';
import type { StrategyPortfolioContext } from './types';
import { round2, round4, clamp } from './portfolioMath';

export interface AllocationProposal {
  strategyId: string;
  amount: number;
  pct: number;
}

export function validateAllocations(
  proposals: AllocationProposal[],
  totalCapital: number,
): { ok: boolean; errors: string[]; totalAllocated: number } {
  const errors: string[] = [];
  let totalAllocated = 0;
  for (const p of proposals) {
    if (p.amount < 0) errors.push(`${p.strategyId}: negative allocation not allowed.`);
    if (p.pct < 0) errors.push(`${p.strategyId}: negative percentage not allowed.`);
    totalAllocated += p.amount;
  }
  if (totalAllocated > totalCapital + 0.01) {
    errors.push(`Total allocation ${round2(totalAllocated)} exceeds available capital ${round2(totalCapital)}.`);
  }
  return { ok: errors.length === 0, errors, totalAllocated: round2(totalAllocated) };
}

export function computeAllocationsByMethod(
  method: AllocationMethod,
  contexts: StrategyPortfolioContext[],
  totalCapital: number,
  manual?: Record<string, { amount?: number; pct?: number }>,
): AllocationProposal[] {
  const eligible = contexts.filter((c) => c.deploymentStatus === 'paper_deployed' || c.deploymentStatus === 'live');
  if (!eligible.length) return [];

  switch (method) {
    case 'equal': {
      const each = totalCapital / eligible.length;
      const pct = 100 / eligible.length;
      return eligible.map((c) => ({ strategyId: c.strategyId, amount: round2(each), pct: round4(pct) }));
    }
    case 'fixed':
    case 'percentage':
    case 'manual': {
      return eligible.map((c) => {
        const m = manual?.[c.strategyId];
        const amount = m?.amount ?? c.allocatedAmount;
        const pct = m?.pct ?? (totalCapital > 0 ? (amount / totalCapital) * 100 : 0);
        return { strategyId: c.strategyId, amount: round2(amount), pct: round4(pct) };
      });
    }
    case 'risk_weighted': {
      const invRisk = eligible.map((c) => {
        const risk = Math.max(c.aiRiskScore, 5);
        return { id: c.strategyId, w: 1 / risk };
      });
      const sum = invRisk.reduce((a, r) => a + r.w, 0) || 1;
      return invRisk.map((r) => {
        const pct = (r.w / sum) * 100;
        return { strategyId: r.id, amount: round2((pct / 100) * totalCapital), pct: round4(pct) };
      });
    }
    case 'performance_weighted': {
      const scores = eligible.map((c) => {
        const score = Math.max(c.winRate * 0.4 + c.profitFactor * 15 + c.healthScore * 0.3, 1);
        return { id: c.strategyId, w: score };
      });
      const sum = scores.reduce((a, s) => a + s.w, 0) || 1;
      return scores.map((s) => {
        const pct = (s.w / sum) * 100;
        return { strategyId: s.id, amount: round2((pct / 100) * totalCapital), pct: round4(pct) };
      });
    }
    case 'confidence_weighted': {
      const scores = eligible.map((c) => ({
        id: c.strategyId,
        w: Math.max(c.averageConfidence ?? 50, 10),
      }));
      const sum = scores.reduce((a, s) => a + s.w, 0) || 1;
      return scores.map((s) => {
        const pct = (s.w / sum) * 100;
        return { strategyId: s.id, amount: round2((pct / 100) * totalCapital), pct: round4(pct) };
      });
    }
    default:
      return [];
  }
}

export function buildAllocationRows(
  contexts: StrategyPortfolioContext[],
  stored: Map<string, { allocatedAmount: number; allocatedPct: number; allocationMethod: AllocationMethod; isActive: boolean }>,
  totalCapital: number,
  suggested?: Map<string, AllocationProposal>,
): StrategyAllocationRow[] {
  return contexts.map((ctx) => {
    const s = stored.get(ctx.strategyId);
    const sug = suggested?.get(ctx.strategyId);
    const deployed = ctx.deploymentStatus === 'paper_deployed' || ctx.deploymentStatus === 'live';
    const eligible = deployed;
    return {
      strategyId: ctx.strategyId,
      strategyName: ctx.strategyName,
      deploymentStatus: ctx.deploymentStatus,
      environment: ctx.environment,
      allocationMethod: s?.allocationMethod ?? 'manual',
      allocatedAmount: s?.allocatedAmount ?? 0,
      allocatedPct: s?.allocatedPct ?? 0,
      suggestedAmount: sug?.amount ?? null,
      suggestedPct: sug?.pct ?? null,
      isActive: s?.isActive ?? false,
      eligible,
      ineligibleReason: eligible ? undefined : 'Strategy must be paper or live deployed to receive capital.',
    };
  });
}

export function normalizePctFromAmount(amount: number, totalCapital: number): number {
  if (totalCapital <= 0) return 0;
  return round4(clamp((amount / totalCapital) * 100, 0, 100));
}
