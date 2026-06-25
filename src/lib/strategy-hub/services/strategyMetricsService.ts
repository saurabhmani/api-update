// ════════════════════════════════════════════════════════════════
//  Strategy Metrics Service — evidence-based performance per strategy
// ════════════════════════════════════════════════════════════════

import {
  buildPerformanceReport,
  loadBacktestOutcomes,
  loadDirectSignalOutcomes,
  loadObservedOutcomes,
  loadStrategyPerformanceSnapshots,
  dedupeOutcomesBySignal,
  type PerformanceWindow,
  type StrategyPerformance,
} from '@/lib/strategies/strategyPerformance';
import type { StrategyHubPerformanceSummary, StrategyPerformanceDetail } from '../types';

function mapSummary(perf: StrategyPerformance | null | undefined): StrategyHubPerformanceSummary | null {
  if (!perf) return null;
  return {
    winRate: perf.winRate,
    totalSignals: perf.totalSignals,
    expectancy: perf.expectancy,
    healthScore: perf.strategyHealthScore,
    healthLabel: perf.healthLabel,
    dataStatus: perf.performanceStatus,
  };
}

function mapDetail(perf: StrategyPerformance, window: string): StrategyPerformanceDetail {
  return {
    window,
    winRate: perf.winRate,
    lossRate: perf.lossRate,
    totalSignals: perf.totalSignals,
    evaluatedSignals: perf.evaluatedSignals,
    expectancy: perf.expectancy,
    profitFactor: perf.profitFactor,
    maxDrawdownPct: perf.maxDrawdownPct,
    averageReturnPct: perf.averageReturnPct,
    averageWinPct: perf.averageWinPct,
    averageLossPct: perf.averageLossPct,
    targetHitRate: perf.targetHitRate,
    stopHitRate: perf.stopHitRate,
    strategyHealthScore: perf.strategyHealthScore,
    healthLabel: perf.healthLabel,
    recommendation: perf.recommendation,
    performanceStatus: perf.performanceStatus,
    performanceSource: perf.performanceSource,
  };
}

async function loadPerformanceMap(window: PerformanceWindow): Promise<Map<string, StrategyPerformance>> {
  const [direct, observed, backtests, snapshots] = await Promise.all([
    loadDirectSignalOutcomes(window).catch(() => []),
    loadObservedOutcomes(window).catch(() => []),
    loadBacktestOutcomes(window).catch(() => []),
    loadStrategyPerformanceSnapshots(window).catch(() => new Map()),
  ]);
  const outcomes = dedupeOutcomesBySignal([...direct, ...observed, ...backtests]);
  const { report } = buildPerformanceReport(outcomes, window, snapshots);
  return new Map(report.strategies.map((s) => [s.strategyId, s]));
}

export async function loadStrategyMetrics(
  strategyId: string,
  window: PerformanceWindow = '90D',
): Promise<{ summary: StrategyHubPerformanceSummary | null; detail: StrategyPerformanceDetail | null }> {
  const perfMap = await loadPerformanceMap(window);
  const perf = perfMap.get(strategyId) ?? null;
  return {
    summary: mapSummary(perf),
    detail: perf ? mapDetail(perf, window) : null,
  };
}

export async function loadAllStrategyMetrics(
  window: PerformanceWindow = '90D',
): Promise<Map<string, StrategyHubPerformanceSummary>> {
  const perfMap = await loadPerformanceMap(window);
  const result = new Map<string, StrategyHubPerformanceSummary>();
  for (const [id, perf] of perfMap) {
    const summary = mapSummary(perf);
    if (summary) result.set(id, summary);
  }
  return result;
}

export async function attachMetricsToSummaries<T extends { strategyId: string }>(
  items: T[],
  window: PerformanceWindow = '90D',
): Promise<Array<T & { performance: StrategyHubPerformanceSummary | null }>> {
  const perfMap = await loadPerformanceMap(window);
  return items.map((item) => ({
    ...item,
    performance: mapSummary(perfMap.get(item.strategyId)),
  }));
}
