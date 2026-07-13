// ════════════════════════════════════════════════════════════════
//  Phase 7 — Benchmark Framework
// ════════════════════════════════════════════════════════════════

import type { BenchmarkMetrics, ResearchTrade } from '../types';

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

function std(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / values.length);
}

export function computeBenchmarkMetrics(
  trades: readonly ResearchTrade[],
  equityCurve: readonly number[],
): BenchmarkMetrics {
  const returns = trades.map((t) => t.returnPct / 100);
  const wins = returns.filter((r) => r > 0);
  const losses = returns.filter((r) => r <= 0);
  const winRate = returns.length === 0 ? 0 : wins.length / returns.length;
  const grossProfit = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));
  const profitFactor = grossLoss === 0 ? grossProfit : grossProfit / grossLoss;
  const avgReturn = mean(returns);
  const vol = std(returns);
  const sharpe = vol === 0 ? 0 : (avgReturn / vol) * Math.sqrt(252);
  const downside = std(returns.filter((r) => r < 0));
  const sortino = downside === 0 ? sharpe : (avgReturn / downside) * Math.sqrt(252);

  let peak = equityCurve[0] ?? 1;
  let maxDd = 0;
  for (const e of equityCurve) {
    peak = Math.max(peak, e);
    maxDd = Math.max(maxDd, (peak - e) / peak);
  }

  const totalReturn = equityCurve.length < 2
    ? 0
    : (equityCurve[equityCurve.length - 1] - equityCurve[0]) / equityCurve[0];
  const calmar = maxDd === 0 ? 0 : totalReturn / maxDd;
  const recoveryFactor = maxDd === 0 ? 0 : totalReturn / maxDd;

  return {
    sharpe: Math.round(sharpe * 1000) / 1000,
    sortino: Math.round(sortino * 1000) / 1000,
    calmar: Math.round(calmar * 1000) / 1000,
    profitFactor: Math.round(profitFactor * 1000) / 1000,
    winRate: Math.round(winRate * 10000) / 10000,
    maxDrawdown: Math.round(maxDd * 10000) / 10000,
    recoveryFactor: Math.round(recoveryFactor * 1000) / 1000,
    totalReturn: Math.round(totalReturn * 10000) / 10000,
  };
}

export interface BenchmarkComparison {
  baselineLabel: string;
  candidateLabel: string;
  baseline: BenchmarkMetrics;
  candidate: BenchmarkMetrics;
  deltas: Record<keyof BenchmarkMetrics, number>;
  recommendation: 'baseline' | 'candidate' | 'inconclusive';
}

export function compareBenchmarks(
  baseline: BenchmarkMetrics,
  candidate: BenchmarkMetrics,
  baselineLabel = 'product_a_baseline',
  candidateLabel = 'experimental',
): BenchmarkComparison {
  const deltas = {
    sharpe: candidate.sharpe - baseline.sharpe,
    sortino: candidate.sortino - baseline.sortino,
    calmar: candidate.calmar - baseline.calmar,
    profitFactor: candidate.profitFactor - baseline.profitFactor,
    winRate: candidate.winRate - baseline.winRate,
    maxDrawdown: candidate.maxDrawdown - baseline.maxDrawdown,
    recoveryFactor: candidate.recoveryFactor - baseline.recoveryFactor,
    totalReturn: candidate.totalReturn - baseline.totalReturn,
  };

  let recommendation: BenchmarkComparison['recommendation'] = 'inconclusive';
  if (deltas.sharpe > 0.1 && deltas.maxDrawdown <= 0 && deltas.winRate >= 0) recommendation = 'candidate';
  if (deltas.sharpe < -0.1 || deltas.maxDrawdown > 0.05) recommendation = 'baseline';

  return { baselineLabel, candidateLabel, baseline, candidate, deltas, recommendation };
}
