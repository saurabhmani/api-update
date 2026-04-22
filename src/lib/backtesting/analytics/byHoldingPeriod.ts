// ════════════════════════════════════════════════════════════════
//  Analytics By Holding Period
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade } from '../types';
import { computeExpectancy } from '../metrics/expectancyMetrics';

export interface HoldingPeriodAnalytics {
  period: string;
  barsLow: number;
  barsHigh: number;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  profitFactor: number;
  expectancyR: number;
  avgMfePct: number;
  avgMaePct: number;
  dominantExitReason: string | null;
}

const HOLDING_PERIODS = [
  { label: '1 bar (intraday/next day)', low: 0, high: 2 },
  { label: '2-3 bars', low: 2, high: 4 },
  { label: '4-5 bars (1 week)', low: 4, high: 6 },
  { label: '6-10 bars (1-2 weeks)', low: 6, high: 11 },
  { label: '11-15 bars (2-3 weeks)', low: 11, high: 16 },
  { label: '15+ bars', low: 16, high: 999 },
];

export function analyzeByHoldingPeriod(trades: SimulatedTrade[]): HoldingPeriodAnalytics[] {
  return HOLDING_PERIODS.map(period => {
    const pTrades = trades.filter(t => t.barsInTrade >= period.low && t.barsInTrade < period.high);
    const n = pTrades.length;
    if (n === 0) {
      return { period: period.label, barsLow: period.low, barsHigh: period.high, trades: 0, winRate: 0, avgReturnPct: 0, profitFactor: 0, expectancyR: 0, avgMfePct: 0, avgMaePct: 0, dominantExitReason: null };
    }

    const wins = pTrades.filter(t => t.outcome === 'win');
    const exp = computeExpectancy(pTrades);

    // Most common exit reason
    const exitCounts: Record<string, number> = {};
    for (const t of pTrades) if (t.exitReason) exitCounts[t.exitReason] = (exitCounts[t.exitReason] || 0) + 1;
    const dominant = Object.entries(exitCounts).sort((a, b) => b[1] - a[1])[0];

    return {
      period: period.label, barsLow: period.low, barsHigh: period.high,
      trades: n,
      winRate: r(wins.length / n),
      avgReturnPct: r(pTrades.reduce((s, t) => s + t.returnPct, 0) / n),
      profitFactor: exp.profitFactor,
      expectancyR: exp.expectancyR,
      avgMfePct: r(pTrades.reduce((s, t) => s + t.mfePct, 0) / n),
      avgMaePct: r(pTrades.reduce((s, t) => s + t.maePct, 0) / n),
      dominantExitReason: dominant?.[0] ?? null,
    };
  });
}

function r(v: number): number { return Math.round(v * 100) / 100; }
