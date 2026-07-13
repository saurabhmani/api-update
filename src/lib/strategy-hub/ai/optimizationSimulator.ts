// ════════════════════════════════════════════════════════════════
//  Strategy Hub AI — optimization simulator (Phase 7)
//
//  Replays the strategy's real historical outcomes under hypothetical
//  filters (confidence threshold, regime restriction, direction,
//  approval gate) and reports the metric delta. This is a pure
//  read-only computation: production configuration is never touched.
// ════════════════════════════════════════════════════════════════

import type { PerformanceOutcomeRow } from '@/lib/strategies/strategyPerformance';
import { computeSimulationMetrics, round1, round2 } from './aiMath';
import type { SimulationParams, SimulationResult } from './types';

export function applySimulationFilters(
  rows: PerformanceOutcomeRow[],
  params: SimulationParams,
): PerformanceOutcomeRow[] {
  let filtered = rows;
  if (params.minConfidence != null) {
    const min = params.minConfidence;
    filtered = filtered.filter((r) => (r.confidenceScore ?? -1) >= min);
  }
  if (params.excludedRegimes?.length) {
    const excluded = new Set(params.excludedRegimes.map((r) => r.toLowerCase()));
    filtered = filtered.filter((r) => !excluded.has(String(r.regime ?? '').toLowerCase()));
  }
  if (params.direction) {
    filtered = filtered.filter((r) => r.direction === params.direction);
  }
  if (params.approvedOnly) {
    filtered = filtered.filter((r) => r.approvalStatus === 'APPROVED');
  }
  return filtered;
}

export function simulateStrategyChanges(
  strategyId: string,
  rows: PerformanceOutcomeRow[],
  params: SimulationParams,
  window: string,
): SimulationResult {
  const baseline = computeSimulationMetrics(rows);
  const simulatedRows = applySimulationFilters(rows, params);
  const simulated = computeSimulationMetrics(simulatedRows);

  const notes: string[] = [];
  if (baseline.trades === 0) {
    notes.push(`No evaluated historical trades in the ${window} window — the simulation has no data to replay.`);
  } else {
    notes.push(`Replayed ${baseline.trades} real historical outcomes; ${simulated.trades} survive the simulated filters.`);
  }
  if (simulated.trades > 0 && simulated.trades < 5) {
    notes.push('Fewer than 5 trades remain after filtering — treat the simulated metrics as indicative only.');
  }
  if (params.minConfidence != null) {
    notes.push(`Confidence filter: only signals with confidence ≥ ${params.minConfidence} are kept.`);
  }
  if (params.excludedRegimes?.length) {
    notes.push(`Regime filter: excluded ${params.excludedRegimes.join(', ')}.`);
  }
  notes.push('RSI/ADX parameter simulation requires per-signal indicator snapshots, which are not persisted with outcomes; use confidence and regime filters as the supported proxies.');

  // Ranking impact heuristic mirrors the extended-ranking score drivers
  // (win rate, profit factor, drawdown).
  let rankingImpact: SimulationResult['rankingImpact'] = 'neutral';
  if (baseline.trades < 5 || simulated.trades < 3) {
    rankingImpact = 'insufficient_data';
  } else {
    const scoreDelta =
      (simulated.winRate - baseline.winRate) * 0.5
      + (simulated.profitFactor - baseline.profitFactor) * 5
      - (simulated.maxDrawdownPct - baseline.maxDrawdownPct) * 0.5;
    if (scoreDelta > 3) rankingImpact = 'likely_up';
    else if (scoreDelta < -3) rankingImpact = 'likely_down';
  }

  return {
    strategyId,
    window,
    params,
    baseline,
    simulated,
    delta: {
      winRate: round1(simulated.winRate - baseline.winRate),
      profitFactor: round2(simulated.profitFactor - baseline.profitFactor),
      maxDrawdownPct: round2(simulated.maxDrawdownPct - baseline.maxDrawdownPct),
      expectancy: round2(simulated.expectancy - baseline.expectancy),
      trades: simulated.trades - baseline.trades,
    },
    rankingImpact,
    notes,
    productionUnchanged: true,
  };
}
