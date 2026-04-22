// ════════════════════════════════════════════════════════════════
//  Analytics By Risk Band
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade } from '../types';
import { computeExpectancy } from '../metrics/expectancyMetrics';

export interface RiskBandAnalytics {
  band: string;
  bandLow: number;
  bandHigh: number;
  trades: number;
  winRate: number;
  avgReturnPct: number;
  profitFactor: number;
  expectancyR: number;
  avgMaePct: number;
  stopHitRate: number;
}

const RISK_BANDS = [
  { label: 'Low (0-30)', low: 0, high: 31 },
  { label: 'Moderate (31-55)', low: 31, high: 56 },
  { label: 'Elevated (56-75)', low: 56, high: 76 },
  { label: 'High (76-100)', low: 76, high: 101 },
];

export function analyzeByRiskBand(trades: SimulatedTrade[]): RiskBandAnalytics[] {
  return RISK_BANDS.map(band => {
    // Use riskScore if available, otherwise estimate from MAE
    const bTrades = trades.filter(t => {
      const risk = (t as any).riskScore ?? Math.min(100, t.maePct * 20);
      return risk >= band.low && risk < band.high;
    });
    const n = bTrades.length;
    if (n === 0) {
      return { band: band.label, bandLow: band.low, bandHigh: band.high, trades: 0, winRate: 0, avgReturnPct: 0, profitFactor: 0, expectancyR: 0, avgMaePct: 0, stopHitRate: 0 };
    }

    const wins = bTrades.filter(t => t.outcome === 'win');
    const exp = computeExpectancy(bTrades);

    return {
      band: band.label, bandLow: band.low, bandHigh: band.high,
      trades: n,
      winRate: r(wins.length / n),
      avgReturnPct: r(bTrades.reduce((s, t) => s + t.returnPct, 0) / n),
      profitFactor: exp.profitFactor,
      expectancyR: exp.expectancyR,
      avgMaePct: r(bTrades.reduce((s, t) => s + t.maePct, 0) / n),
      stopHitRate: r(bTrades.filter(t => t.stopHit).length / n),
    };
  });
}

function r(v: number): number { return Math.round(v * 100) / 100; }
