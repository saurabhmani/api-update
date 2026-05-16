// ════════════════════════════════════════════════════════════════
//  Expectancy Metrics — Statistical edge measurement
//
//  Expectancy = (Win% × Avg Win) − (Loss% × Avg Loss)
//  This is the single most important metric: your expected
//  profit per trade. Positive = you have an edge.
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade } from '../types';

export interface ExpectancyResult {
  /** Expectancy in % return per trade */
  expectancyPct: number;
  /** Expectancy in R-multiples per trade */
  expectancyR: number;
  /** Expected value per ₹1 risked */
  expectedValuePerRupeeRisked: number;
  /** System Quality Number (Van Tharp): expectancyR / stdDevR */
  sqn: number;
  /** Payoff ratio: avg win / avg loss (not size-adjusted) */
  payoffRatio: number;
  /** Kelly criterion: optimal bet fraction */
  kellyCriterion: number;
  /** Half-Kelly: conservative sizing */
  halfKelly: number;
  /** Profit factor: gross profit / gross loss */
  profitFactor: number;
  /** Edge per trade in currency (using avg position) */
  edgePerTradeCurrency: number;
}

export function computeExpectancy(trades: SimulatedTrade[]): ExpectancyResult {
  const n = trades.length;
  if (n === 0) return emptyExpectancy();

  const wins = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');

  const winRate = wins.length / n;
  const lossRate = losses.length / n;

  const avgWinPct = wins.length > 0 ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0;
  const avgLossPct = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.returnPct, 0) / losses.length) : 0;

  const avgWinR = wins.length > 0 ? wins.reduce((s, t) => s + t.returnR, 0) / wins.length : 0;
  const avgLossR = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.returnR, 0) / losses.length) : 0;

  // Core expectancy formulas
  const expectancyPct = (winRate * avgWinPct) - (lossRate * avgLossPct);
  const expectancyR = (winRate * avgWinR) - (lossRate * avgLossR);

  // Expected value per ₹1 risked
  const expectedValuePerRupeeRisked = avgLossR > 0 ? expectancyR / avgLossR : 0;

  // SQN (System Quality Number) — Van Tharp
  const returnRs = trades.map(t => t.returnR);
  const meanR = returnRs.reduce((s, v) => s + v, 0) / n;
  const varianceR = returnRs.reduce((s, v) => s + (v - meanR) ** 2, 0) / n;
  const stdDevR = Math.sqrt(varianceR);
  const sqn = stdDevR > 0 ? (meanR / stdDevR) * Math.sqrt(Math.min(n, 100)) : 0;

  // Payoff ratio
  const payoffRatio = avgLossPct > 0 ? avgWinPct / avgLossPct : avgWinPct > 0 ? Infinity : 0;

  // Kelly criterion: f* = (bp - q) / b where b=payoff ratio, p=win rate, q=loss rate
  const kellyCriterion = payoffRatio > 0 ? (payoffRatio * winRate - lossRate) / payoffRatio : 0;
  const halfKelly = kellyCriterion / 2;

  // Profit factor
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Edge per trade
  const avgPnl = trades.reduce((s, t) => s + t.netPnl, 0) / n;

  return {
    expectancyPct: r(expectancyPct),
    expectancyR: r(expectancyR),
    expectedValuePerRupeeRisked: r(expectedValuePerRupeeRisked),
    sqn: r(sqn),
    payoffRatio: r(payoffRatio),
    kellyCriterion: r(Math.max(0, kellyCriterion)),
    halfKelly: r(Math.max(0, halfKelly)),
    profitFactor: r(profitFactor),
    edgePerTradeCurrency: r(avgPnl),
  };
}

function emptyExpectancy(): ExpectancyResult {
  return {
    expectancyPct: 0, expectancyR: 0, expectedValuePerRupeeRisked: 0,
    sqn: 0, payoffRatio: 0, kellyCriterion: 0, halfKelly: 0,
    profitFactor: 0, edgePerTradeCurrency: 0,
  };
}

function r(v: number): number { return Math.round(v * 1000) / 1000; }
