// ════════════════════════════════════════════════════════════════
//  Strategy Hub AI — shared statistical helpers (Phase 7)
// ════════════════════════════════════════════════════════════════

import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import type { SimulationMetrics } from './types';

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Ordinary least-squares slope + fitted next value.
 * x is the index of each point (equally spaced buckets).
 */
export function linearTrend(values: number[]): {
  slope: number;
  intercept: number;
  next: number;
  r2: number;
} {
  const n = values.length;
  if (n === 0) return { slope: 0, intercept: 0, next: 0, r2: 0 };
  if (n === 1) return { slope: 0, intercept: values[0], next: values[0], r2: 0 };

  const xMean = (n - 1) / 2;
  const yMean = values.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = i - xMean;
    const dy = values[i] - yMean;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = yMean - slope * xMean;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, next: intercept + slope * n, r2 };
}

const CLOSED_OUTCOMES = new Set(['WIN', 'LOSS', 'TARGET_HIT', 'STOP_HIT', 'EXPIRED']);

export function isEvaluatedRow(row: PerformanceOutcomeRow): boolean {
  return CLOSED_OUTCOMES.has(String(row.outcome)) && row.returnPct != null;
}

/** Max drawdown (%) of the cumulative return curve built from row order. */
export function maxDrawdownPctFromRows(rows: PerformanceOutcomeRow[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const row of rows) {
    equity += row.returnPct ?? 0;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return round2(maxDd);
}

/**
 * Core metric set used by both the simulator baseline and simulated
 * scenarios. Operates purely on the rows it is given — the caller
 * controls which historical subset applies.
 */
export function computeSimulationMetrics(rows: PerformanceOutcomeRow[]): SimulationMetrics {
  const evaluated = rows.filter(isEvaluatedRow);
  const wins = evaluated.filter((r) => (r.returnPct ?? 0) > 0);
  const losses = evaluated.filter((r) => (r.returnPct ?? 0) <= 0);
  const grossWin = wins.reduce((a, r) => a + (r.returnPct ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((a, r) => a + (r.returnPct ?? 0), 0));
  const confidences = evaluated
    .map((r) => r.confidenceScore)
    .filter((c): c is number => c != null);

  const winRate = evaluated.length ? (wins.length / evaluated.length) * 100 : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;

  return {
    trades: evaluated.length,
    winRate: round1(winRate),
    profitFactor: grossLoss > 0 ? round2(grossWin / grossLoss) : (grossWin > 0 ? 99 : 0),
    maxDrawdownPct: maxDrawdownPctFromRows(evaluated),
    expectancy: round2((winRate / 100) * avgWin - (1 - winRate / 100) * avgLoss),
    averageConfidence: confidences.length ? round1(mean(confidences) ?? 0) : null,
    averageReturnPct: evaluated.length
      ? round2(evaluated.reduce((a, r) => a + (r.returnPct ?? 0), 0) / evaluated.length)
      : 0,
  };
}
