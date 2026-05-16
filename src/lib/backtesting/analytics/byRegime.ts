// ════════════════════════════════════════════════════════════════
//  Analytics By Market Regime
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade, MarketRegimeLabel } from '../types';
import { computeExpectancy } from '../metrics/expectancyMetrics';

export interface RegimeAnalytics {
  regime: MarketRegimeLabel;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  profitFactor: number;
  expectancyR: number;
  target1HitRate: number;
  avgBarsHeld: number;
  dominantStrategy: string | null;
}

export function analyzeByRegime(trades: SimulatedTrade[]): RegimeAnalytics[] {
  const grouped = new Map<MarketRegimeLabel, SimulatedTrade[]>();
  for (const t of trades) {
    const list = grouped.get(t.regime) ?? [];
    list.push(t);
    grouped.set(t.regime, list);
  }

  return Array.from(grouped.entries()).map(([regime, rTrades]) => {
    const n = rTrades.length;
    const wins = rTrades.filter(t => t.outcome === 'win');
    const exp = computeExpectancy(rTrades);

    // Most common strategy in this regime
    const stratCounts: Record<string, number> = {};
    for (const t of rTrades) stratCounts[t.strategy] = (stratCounts[t.strategy] || 0) + 1;
    const dominant = Object.entries(stratCounts).sort((a, b) => b[1] - a[1])[0];

    return {
      regime, trades: n,
      winRate: r(n > 0 ? wins.length / n : 0),
      avgReturnPct: r(n > 0 ? rTrades.reduce((s, t) => s + t.returnPct, 0) / n : 0),
      profitFactor: exp.profitFactor,
      expectancyR: exp.expectancyR,
      target1HitRate: r(n > 0 ? rTrades.filter(t => t.target1Hit).length / n : 0),
      avgBarsHeld: r(n > 0 ? rTrades.reduce((s, t) => s + t.barsInTrade, 0) / n : 0),
      dominantStrategy: dominant?.[0] ?? null,
    };
  }).sort((a, b) => b.expectancyR - a.expectancyR);
}

function r(v: number): number { return Math.round(v * 100) / 100; }
