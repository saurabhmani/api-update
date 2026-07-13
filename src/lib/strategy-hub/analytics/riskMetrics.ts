// ════════════════════════════════════════════════════════════════
//  Risk-adjusted metrics from live outcome rows (Phase 5)
// ════════════════════════════════════════════════════════════════

import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';

const TRADING_DAYS_PER_YEAR = 252;
const RISK_FREE_RATE = 0.06;

function round(value: number, precision = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return round(sorted[lo], 2);
  return round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo), 2);
}

export function computeAverageConfidence(rows: PerformanceOutcomeRow[]): number | null {
  const scores = rows
    .map((r) => r.confidenceScore)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (scores.length === 0) return null;
  return round(scores.reduce((s, v) => s + v, 0) / scores.length, 1);
}

export function computeConfidencePercentiles(rows: PerformanceOutcomeRow[]): {
  average: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  p90: number | null;
} {
  const scores = rows
    .map((r) => r.confidenceScore)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (scores.length === 0) {
    return { average: null, median: null, p25: null, p75: null, p90: null };
  }
  return {
    average: round(scores.reduce((s, v) => s + v, 0) / scores.length, 1),
    median: percentile(scores, 50),
    p25: percentile(scores, 25),
    p75: percentile(scores, 75),
    p90: percentile(scores, 90),
  };
}

/** Sharpe & Sortino from sequential trade returns (annualized). */
export function computeRiskAdjustedFromReturns(returns: number[]): {
  sharpeRatio: number | null;
  sortinoRatio: number | null;
} {
  if (returns.length < 5) return { sharpeRatio: null, sortinoRatio: null };

  const dailyReturns = returns.map((r) => r / 100);
  const avgReturn = dailyReturns.reduce((s, v) => s + v, 0) / dailyReturns.length;
  const dailyRf = RISK_FREE_RATE / TRADING_DAYS_PER_YEAR;
  const excessReturn = avgReturn - dailyRf;

  const variance = dailyReturns.reduce((s, v) => s + (v - avgReturn) ** 2, 0) / dailyReturns.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (excessReturn / stdDev) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;

  const downsideReturns = dailyReturns.filter((r) => r < dailyRf);
  const downsideVariance = downsideReturns.length > 0
    ? downsideReturns.reduce((s, v) => s + (v - dailyRf) ** 2, 0) / downsideReturns.length
    : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino = downsideDev > 0 ? (excessReturn / downsideDev) * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;

  return {
    sharpeRatio: round(sharpe, 2),
    sortinoRatio: round(sortino, 2),
  };
}

/** CAGR from equity curve built from trade returns. */
export function computeCagrFromReturns(returns: number[], windowDays: number | null): number | null {
  if (returns.length < 2) return null;
  let equity = 100;
  for (const r of returns) {
    equity *= 1 + r / 100;
  }
  const totalReturn = equity / 100 - 1;
  const days = windowDays ?? Math.max(returns.length, 30);
  const years = days / 365;
  if (years <= 0 || totalReturn <= -1) return null;
  return round((Math.pow(1 + totalReturn, 1 / years) - 1) * 100, 2);
}

export function computeConsistencyScore(returns: number[]): number {
  if (returns.length < 3) return 0;
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  // Lower std dev → higher consistency (0–100)
  return round(Math.max(0, 100 - stdDev * 8), 1);
}

export function windowDaysForAnalytics(window: string): number | null {
  switch (window) {
    case 'TODAY': return 1;
    case '7D': return 7;
    case '30D': return 30;
    case '90D': return 90;
    case '180D': return 180;
    case '1Y': return 365;
    case 'ALL': return null;
    default: return 90;
  }
}
