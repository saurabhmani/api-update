// ════════════════════════════════════════════════════════════════
//  Analytics By Strategy
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade, StrategyName } from '../types';
import { computeExpectancy } from '../metrics/expectancyMetrics';
import { computeMfeMaeStats } from '../metrics/mfeMae';

export interface StrategyAnalytics {
  strategy: StrategyName;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgReturnPct: number;
  avgReturnR: number;
  profitFactor: number;
  expectancyR: number;
  sqn: number;
  avgMfePct: number;
  avgMaePct: number;
  edgeRatio: number;
  target1HitRate: number;
  target2HitRate: number;
  target3HitRate: number;
  avgBarsHeld: number;
  bestSymbol: string | null;
  worstSymbol: string | null;
}

export function analyzeByStrategy(trades: SimulatedTrade[]): StrategyAnalytics[] {
  const grouped = new Map<StrategyName, SimulatedTrade[]>();
  for (const t of trades) {
    const list = grouped.get(t.strategy) ?? [];
    list.push(t);
    grouped.set(t.strategy, list);
  }

  return Array.from(grouped.entries()).map(([strategy, sTrades]) => {
    const n = sTrades.length;
    const wins = sTrades.filter(t => t.outcome === 'win');
    const losses = sTrades.filter(t => t.outcome === 'loss');
    const exp = computeExpectancy(sTrades);
    const mfe = computeMfeMaeStats(sTrades);
    const sorted = [...sTrades].sort((a, b) => b.returnPct - a.returnPct);

    return {
      strategy, trades: n, wins: wins.length, losses: losses.length,
      winRate: r(n > 0 ? wins.length / n : 0),
      avgReturnPct: r(n > 0 ? sTrades.reduce((s, t) => s + t.returnPct, 0) / n : 0),
      avgReturnR: r(n > 0 ? sTrades.reduce((s, t) => s + t.returnR, 0) / n : 0),
      profitFactor: exp.profitFactor,
      expectancyR: exp.expectancyR,
      sqn: exp.sqn,
      avgMfePct: mfe.avgMfePct, avgMaePct: mfe.avgMaePct, edgeRatio: mfe.edgeRatio,
      target1HitRate: r(n > 0 ? sTrades.filter(t => t.target1Hit).length / n : 0),
      target2HitRate: r(n > 0 ? sTrades.filter(t => t.target2Hit).length / n : 0),
      target3HitRate: r(n > 0 ? sTrades.filter(t => t.target3Hit).length / n : 0),
      avgBarsHeld: r(n > 0 ? sTrades.reduce((s, t) => s + t.barsInTrade, 0) / n : 0),
      bestSymbol: sorted[0]?.symbol ?? null,
      worstSymbol: sorted[sorted.length - 1]?.symbol ?? null,
    };
  }).sort((a, b) => b.expectancyR - a.expectancyR);
}

function r(v: number): number { return Math.round(v * 100) / 100; }
