// ════════════════════════════════════════════════════════════════
//  Outcome Metrics — Signal + Trade outcome classification
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade, SimulatedSignal, SignalOutcome, OutcomeLabel } from '../types';

export interface OutcomeDistribution {
  totalSignals: number;
  triggered: number;
  triggerRate: number;
  expired: number;
  invalidated: number;
  filtered: number;
  outcomes: { label: string; count: number; pct: number }[];
}

export interface TradeOutcomeStats {
  totalTrades: number;
  wins: number;
  losses: number;
  breakevens: number;
  winRate: number;
  lossRate: number;
  avgGainPct: number;
  avgLossPct: number;
  avgGainR: number;
  avgLossR: number;
  largestWinPct: number;
  largestLossPct: number;
  consecutiveWins: number;
  consecutiveLosses: number;
  targetHitRates: { target1: number; target2: number; target3: number };
  stopHitRate: number;
  avgBarsToEntry: number;
  avgBarsHeld: number;
  exitReasonDistribution: { reason: string; count: number; pct: number }[];
}

/** Compute signal-level outcome distribution */
export function computeSignalOutcomes(
  signals: SimulatedSignal[],
  trades: SimulatedTrade[],
): OutcomeDistribution {
  const total = signals.length;
  const triggered = signals.filter(s => s.status === 'triggered').length;
  const expired = signals.filter(s => s.status === 'expired').length;
  const filtered = signals.filter(s => s.status === 'filtered').length;
  const invalidated = total - triggered - expired - filtered;

  // Map trade outcomes
  const outcomeCounts: Record<string, number> = {};
  for (const t of trades) {
    outcomeCounts[t.outcome] = (outcomeCounts[t.outcome] || 0) + 1;
  }

  return {
    totalSignals: total,
    triggered,
    triggerRate: total > 0 ? r(triggered / total) : 0,
    expired, invalidated, filtered,
    outcomes: Object.entries(outcomeCounts).map(([label, count]) => ({
      label, count, pct: trades.length > 0 ? r(count / trades.length * 100) : 0,
    })),
  };
}

/** Compute detailed trade outcome statistics */
export function computeTradeOutcomeStats(trades: SimulatedTrade[]): TradeOutcomeStats {
  const n = trades.length;
  if (n === 0) return emptyTradeStats();

  const wins = trades.filter(t => t.outcome === 'win');
  const losses = trades.filter(t => t.outcome === 'loss');
  const breakevens = trades.filter(t => t.outcome === 'breakeven');

  const avgGainPct = wins.length > 0 ? r(wins.reduce((s, t) => s + t.returnPct, 0) / wins.length) : 0;
  const avgLossPct = losses.length > 0 ? r(Math.abs(losses.reduce((s, t) => s + t.returnPct, 0) / losses.length)) : 0;
  const avgGainR = wins.length > 0 ? r(wins.reduce((s, t) => s + t.returnR, 0) / wins.length) : 0;
  const avgLossR = losses.length > 0 ? r(Math.abs(losses.reduce((s, t) => s + t.returnR, 0) / losses.length)) : 0;

  const sorted = [...trades].sort((a, b) => b.returnPct - a.returnPct);
  const largestWinPct = sorted[0]?.returnPct ?? 0;
  const largestLossPct = sorted[sorted.length - 1]?.returnPct ?? 0;

  // Consecutive streaks
  let maxConsWins = 0, maxConsLosses = 0, curWins = 0, curLosses = 0;
  for (const t of trades) {
    if (t.outcome === 'win') { curWins++; curLosses = 0; maxConsWins = Math.max(maxConsWins, curWins); }
    else if (t.outcome === 'loss') { curLosses++; curWins = 0; maxConsLosses = Math.max(maxConsLosses, curLosses); }
    else { curWins = 0; curLosses = 0; }
  }

  // Exit reason distribution
  const exitCounts: Record<string, number> = {};
  for (const t of trades) {
    if (t.exitReason) exitCounts[t.exitReason] = (exitCounts[t.exitReason] || 0) + 1;
  }

  return {
    totalTrades: n,
    wins: wins.length, losses: losses.length, breakevens: breakevens.length,
    winRate: r(wins.length / n), lossRate: r(losses.length / n),
    avgGainPct, avgLossPct, avgGainR, avgLossR,
    largestWinPct: r(largestWinPct), largestLossPct: r(largestLossPct),
    consecutiveWins: maxConsWins, consecutiveLosses: maxConsLosses,
    targetHitRates: {
      target1: r(trades.filter(t => t.target1Hit).length / n),
      target2: r(trades.filter(t => t.target2Hit).length / n),
      target3: r(trades.filter(t => t.target3Hit).length / n),
    },
    stopHitRate: r(trades.filter(t => t.stopHit).length / n),
    avgBarsToEntry: r(trades.reduce((s, t) => s + t.barsToEntry, 0) / n),
    avgBarsHeld: r(trades.reduce((s, t) => s + t.barsInTrade, 0) / n),
    exitReasonDistribution: Object.entries(exitCounts).map(([reason, count]) => ({
      reason, count, pct: r(count / n * 100),
    })).sort((a, b) => b.count - a.count),
  };
}

function emptyTradeStats(): TradeOutcomeStats {
  return {
    totalTrades: 0, wins: 0, losses: 0, breakevens: 0,
    winRate: 0, lossRate: 0, avgGainPct: 0, avgLossPct: 0,
    avgGainR: 0, avgLossR: 0, largestWinPct: 0, largestLossPct: 0,
    consecutiveWins: 0, consecutiveLosses: 0,
    targetHitRates: { target1: 0, target2: 0, target3: 0 },
    stopHitRate: 0, avgBarsToEntry: 0, avgBarsHeld: 0,
    exitReasonDistribution: [],
  };
}

function r(v: number): number { return Math.round(v * 100) / 100; }
