// ════════════════════════════════════════════════════════════════
//  Phase 8 — Execution Planner (recommendations only — no broker)
// ════════════════════════════════════════════════════════════════

import type { ExecutionBatch, ExecutionPlan, PrioritizedSignal } from '../types';

export interface ExecutionPlannerConfig {
  slippageBps: number;
  commissionPerTrade: number;
  maxBatchCapital: number;
  batchSize: number;
}

const DEFAULT_CONFIG: ExecutionPlannerConfig = {
  slippageBps: 10,
  commissionPerTrade: 20,
  maxBatchCapital: 500_000,
  batchSize: 3,
};

export function planExecution(
  portfolioId: string,
  prioritized: PrioritizedSignal[],
  config: Partial<ExecutionPlannerConfig> = {},
): ExecutionPlan {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const selected = prioritized.filter((p) => p.selected);
  const batches: ExecutionBatch[] = [];
  let sequence = 0;
  let batchCapital = 0;
  let batchCount = 0;

  for (const item of selected) {
    const capital = item.signal.recommendedCapital;
    if (batchCapital + capital > cfg.maxBatchCapital || batchCount >= cfg.batchSize) {
      sequence += 1;
      batchCapital = 0;
      batchCount = 0;
    }

    const slippage = capital * (cfg.slippageBps / 10_000);
    const fees = cfg.commissionPerTrade;

    batches.push({
      batchId: `batch_${portfolioId}_${sequence}`,
      sequence,
      symbol: item.signal.symbol,
      direction: item.signal.direction === 'SELL' ? 'SELL' : 'BUY',
      quantity: item.signal.recommendedQuantity,
      estimatedCapital: Math.round(capital * 100) / 100,
      estimatedSlippage: Math.round(slippage * 100) / 100,
      estimatedFees: fees,
    });

    batchCapital += capital;
    batchCount += 1;
  }

  const totalCapitalUsage = batches.reduce((s, b) => s + b.estimatedCapital, 0);
  const totalEstimatedSlippage = batches.reduce((s, b) => s + b.estimatedSlippage, 0);
  const totalEstimatedFees = batches.reduce((s, b) => s + b.estimatedFees, 0);

  return {
    portfolioId,
    batches,
    totalCapitalUsage: Math.round(totalCapitalUsage * 100) / 100,
    totalEstimatedSlippage: Math.round(totalEstimatedSlippage * 100) / 100,
    totalEstimatedFees: totalEstimatedFees,
    explanation: `${batches.length} orders in ${new Set(batches.map((b) => b.batchId)).size} batches; capital ${totalCapitalUsage.toFixed(0)}, slippage ${totalEstimatedSlippage.toFixed(0)}, fees ${totalEstimatedFees}`,
  };
}

export function recommendOrderSequence(plan: ExecutionPlan): string[] {
  return plan.batches
    .sort((a, b) => a.sequence - b.sequence || a.symbol.localeCompare(b.symbol))
    .map((b) => `${b.sequence}:${b.direction} ${b.symbol} x${b.quantity}`);
}
