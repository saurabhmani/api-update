// ════════════════════════════════════════════════════════════════
//  MFE / MAE Analysis — Maximum Favorable / Adverse Excursion
//
//  Measures how far price moved in favor of and against each
//  trade before exit. Critical for understanding:
//  - Are we exiting too early? (high MFE vs actual return = leaving money)
//  - Are our stops too tight? (high MAE on winners = shaken out)
//  - Edge ratio (MFE/MAE) = core signal quality metric
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade } from '../types';

export interface MfeMaeStats {
  avgMfePct: number;
  avgMaePct: number;
  medianMfePct: number;
  medianMaePct: number;
  avgMfeR: number;
  avgMaeR: number;
  /** Edge ratio: avg MFE / avg MAE. > 1.5 = good edge */
  edgeRatio: number;
  /** Capture ratio: actual return / MFE. High = good exits */
  captureRatio: number;
  /** Pain ratio: MAE / actual loss. High = stops too loose */
  painRatio: number;
  /** Distribution buckets */
  mfeDistribution: ExcursionBucket[];
  maeDistribution: ExcursionBucket[];
}

export interface ExcursionBucket {
  rangeLabel: string;
  rangeLow: number;
  rangeHigh: number;
  count: number;
  pctOfTotal: number;
}

const EXCURSION_RANGES = [
  { label: '0-1%', low: 0, high: 1 },
  { label: '1-2%', low: 1, high: 2 },
  { label: '2-3%', low: 2, high: 3 },
  { label: '3-5%', low: 3, high: 5 },
  { label: '5-8%', low: 5, high: 8 },
  { label: '8-12%', low: 8, high: 12 },
  { label: '12%+', low: 12, high: 999 },
];

export function computeMfeMaeStats(trades: SimulatedTrade[]): MfeMaeStats {
  if (trades.length === 0) return emptyMfeMae();

  const n = trades.length;
  const mfes = trades.map(t => t.mfePct);
  const maes = trades.map(t => t.maePct);
  const mfeRs = trades.map(t => t.mfeR);
  const maeRs = trades.map(t => t.maeR);

  const avgMfePct = r(mfes.reduce((s, v) => s + v, 0) / n);
  const avgMaePct = r(maes.reduce((s, v) => s + v, 0) / n);
  const avgMfeR = r(mfeRs.reduce((s, v) => s + v, 0) / n);
  const avgMaeR = r(maeRs.reduce((s, v) => s + v, 0) / n);

  const sortedMfe = [...mfes].sort((a, b) => a - b);
  const sortedMae = [...maes].sort((a, b) => a - b);
  const medianMfePct = r(sortedMfe[Math.floor(n / 2)]);
  const medianMaePct = r(sortedMae[Math.floor(n / 2)]);

  const edgeRatio = avgMaePct > 0 ? r(avgMfePct / avgMaePct) : 0;

  // Capture ratio: how much of MFE did we actually capture?
  const wins = trades.filter(t => t.outcome === 'win');
  const captureRatio = wins.length > 0 && avgMfePct > 0
    ? r(wins.reduce((s, t) => s + t.returnPct, 0) / wins.length / avgMfePct)
    : 0;

  // Pain ratio: on losses, how deep did MAE go vs actual loss?
  const losses = trades.filter(t => t.outcome === 'loss');
  const avgLossMae = losses.length > 0 ? losses.reduce((s, t) => s + t.maePct, 0) / losses.length : 0;
  const avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.returnPct, 0) / losses.length) : 0;
  const painRatio = avgLossPct > 0 ? r(avgLossMae / avgLossPct) : 0;

  return {
    avgMfePct, avgMaePct, medianMfePct, medianMaePct,
    avgMfeR, avgMaeR, edgeRatio, captureRatio, painRatio,
    mfeDistribution: buildDistribution(mfes, n),
    maeDistribution: buildDistribution(maes, n),
  };
}

function buildDistribution(values: number[], total: number): ExcursionBucket[] {
  return EXCURSION_RANGES.map(range => {
    const count = values.filter(v => v >= range.low && v < range.high).length;
    return {
      rangeLabel: range.label, rangeLow: range.low, rangeHigh: range.high,
      count, pctOfTotal: total > 0 ? r(count / total * 100) : 0,
    };
  });
}

function emptyMfeMae(): MfeMaeStats {
  return {
    avgMfePct: 0, avgMaePct: 0, medianMfePct: 0, medianMaePct: 0,
    avgMfeR: 0, avgMaeR: 0, edgeRatio: 0, captureRatio: 0, painRatio: 0,
    mfeDistribution: [], maeDistribution: [],
  };
}

function r(v: number): number { return Math.round(v * 100) / 100; }
