// ════════════════════════════════════════════════════════════════
//  Strategy Hub Portfolio — shared math helpers (Phase 8)
// ════════════════════════════════════════════════════════════════

import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import type { PortfolioWindow } from './types';
import type { AnalyticsWindow } from '../analytics/types';

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

export function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

export function parsePortfolioWindow(raw: string | null): PortfolioWindow {
  const v = String(raw ?? '90D').toUpperCase();
  const valid: PortfolioWindow[] = ['TODAY', '7D', '30D', '90D', '1Y', 'ALL'];
  return valid.includes(v as PortfolioWindow) ? (v as PortfolioWindow) : '90D';
}

export function portfolioWindowToAnalytics(window: PortfolioWindow): AnalyticsWindow {
  return window;
}

export function herfindahlIndex(weights: number[]): number {
  if (!weights.length) return 0;
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.reduce((s, w) => s + (w / total) ** 2, 0);
}

export function diversificationScoreFromHhi(hhi: number, n: number): number {
  if (n <= 1) return 0;
  const minHhi = 1 / n;
  const maxHhi = 1;
  const normalized = (hhi - minHhi) / (maxHhi - minHhi);
  return round2(clamp((1 - normalized) * 100, 0, 100));
}

export function pearsonCorrelation(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const xs = a.slice(0, n);
  const ys = b.slice(0, n);
  const xMean = xs.reduce((s, v) => s + v, 0) / n;
  const yMean = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let xVar = 0;
  let yVar = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - xMean;
    const dy = ys[i] - yMean;
    num += dx * dy;
    xVar += dx * dx;
    yVar += dy * dy;
  }
  const denom = Math.sqrt(xVar * yVar);
  return denom > 0 ? round2(num / denom) : null;
}

const CLOSED = new Set(['WIN', 'LOSS', 'TARGET_HIT', 'STOP_HIT', 'EXPIRED']);

export function evaluatedRows(rows: PerformanceOutcomeRow[]): PerformanceOutcomeRow[] {
  return rows.filter((r) => CLOSED.has(String(r.outcome)) && r.returnPct != null);
}

export function strategyReturnSeries(rows: PerformanceOutcomeRow[]): number[] {
  return evaluatedRows(rows)
    .sort((a, b) => String(a.evaluatedAt ?? '').localeCompare(String(b.evaluatedAt ?? '')))
    .map((r) => r.returnPct ?? 0);
}

export function computeWinRate(rows: PerformanceOutcomeRow[]): number {
  const ev = evaluatedRows(rows);
  if (!ev.length) return 0;
  const wins = ev.filter((r) => (r.returnPct ?? 0) > 0).length;
  return round2((wins / ev.length) * 100);
}

export function computeProfitFactor(rows: PerformanceOutcomeRow[]): number {
  const ev = evaluatedRows(rows);
  const grossWin = ev.filter((r) => (r.returnPct ?? 0) > 0).reduce((a, r) => a + (r.returnPct ?? 0), 0);
  const grossLoss = Math.abs(ev.filter((r) => (r.returnPct ?? 0) <= 0).reduce((a, r) => a + (r.returnPct ?? 0), 0));
  return grossLoss > 0 ? round2(grossWin / grossLoss) : (grossWin > 0 ? 99 : 0);
}

export function computeMaxDrawdown(rows: PerformanceOutcomeRow[]): number {
  let equity = 0;
  let peak = 0;
  let maxDd = 0;
  for (const r of evaluatedRows(rows)) {
    equity += r.returnPct ?? 0;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return round2(maxDd);
}

export function weightedPortfolioReturn(
  strategies: Array<{ weightPct: number; returnPct: number }>,
): number {
  const totalWeight = strategies.reduce((a, s) => a + s.weightPct, 0);
  if (totalWeight <= 0) return 0;
  return round2(strategies.reduce((a, s) => a + (s.weightPct / totalWeight) * s.returnPct, 0));
}

export function historicalVar95(dailyReturns: number[]): number | null {
  if (dailyReturns.length < 10) return null;
  const sorted = [...dailyReturns].sort((a, b) => a - b);
  const idx = Math.floor(0.05 * sorted.length);
  return round2(Math.abs(sorted[idx]));
}
