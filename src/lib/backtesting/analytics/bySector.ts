// ════════════════════════════════════════════════════════════════
//  Analytics By Sector
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade } from '../types';
import { computeExpectancy } from '../metrics/expectancyMetrics';

export interface SectorAnalytics {
  sector: string;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  profitFactor: number;
  expectancyR: number;
  avgMfePct: number;
  avgMaePct: number;
  symbols: string[];
}

export function analyzeBySector(trades: SimulatedTrade[]): SectorAnalytics[] {
  const grouped = new Map<string, SimulatedTrade[]>();
  for (const t of trades) {
    const list = grouped.get(t.sector) ?? [];
    list.push(t);
    grouped.set(t.sector, list);
  }

  return Array.from(grouped.entries()).map(([sector, sTrades]) => {
    const n = sTrades.length;
    const wins = sTrades.filter(t => t.outcome === 'win');
    const exp = computeExpectancy(sTrades);
    const symbols = Array.from(new Set(sTrades.map(t => t.symbol)));

    return {
      sector, trades: n,
      winRate: r(n > 0 ? wins.length / n : 0),
      avgReturnPct: r(n > 0 ? sTrades.reduce((s, t) => s + t.returnPct, 0) / n : 0),
      profitFactor: exp.profitFactor,
      expectancyR: exp.expectancyR,
      avgMfePct: r(n > 0 ? sTrades.reduce((s, t) => s + t.mfePct, 0) / n : 0),
      avgMaePct: r(n > 0 ? sTrades.reduce((s, t) => s + t.maePct, 0) / n : 0),
      symbols,
    };
  }).sort((a, b) => b.expectancyR - a.expectancyR);
}

function r(v: number): number { return Math.round(v * 100) / 100; }
