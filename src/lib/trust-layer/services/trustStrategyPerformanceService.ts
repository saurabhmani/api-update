// ════════════════════════════════════════════════════════════════
//  Trust Strategy Performance — wraps strategyPerformance builders
// ════════════════════════════════════════════════════════════════

import {
  VALID_WINDOWS,
  loadBacktestOutcomes,
  loadObservedOutcomes,
  loadDirectSignalOutcomes,
  loadStrategyPerformanceSnapshots,
  buildPerformanceReport,
  dedupeOutcomesBySignal,
  MIN_FOR_LIMITED,
  type PerformanceWindow,
} from '@/lib/strategies/strategyPerformance';
import type { TrustStrategyPerformanceRow } from '../types';

export interface TrustStrategyPerformanceSourceStatus {
  directOutcomeRows: number;
  observedSnapshotRows: number;
  backtestTradeRows: number;
  strategySnapshots: number;
  evaluatedTrades: number;
}

export interface TrustStrategyPerformanceResult {
  rows: TrustStrategyPerformanceRow[];
  sourceStatus: TrustStrategyPerformanceSourceStatus;
}

export async function loadTrustStrategyPerformance(
  window: PerformanceWindow = '90D',
): Promise<TrustStrategyPerformanceResult> {
  const w = VALID_WINDOWS.has(window) ? window : '90D';

  const [direct, observed, backtest, snapshots] = await Promise.all([
    loadDirectSignalOutcomes(w),
    loadObservedOutcomes(w),
    loadBacktestOutcomes(w),
    loadStrategyPerformanceSnapshots(w),
  ]);

  const deduped = dedupeOutcomesBySignal([...direct, ...observed, ...backtest]);
  const { report } = buildPerformanceReport(deduped, w, snapshots);

  // Use the ranked leaderboard — same contract as /strategies/performance.
  // Do NOT dump the full registry: empty strategies were showing 0.0%
  // win rates that looked like real metrics.
  const detailById = new Map(report.strategies.map((s) => [s.strategyId, s]));

  const rows = report.leaderboard
    .filter((e) => e.evaluatedSignals > 0)
    .map((e) => {
      const detail = detailById.get(e.strategyId);
      const performanceStatus = e.performanceStatus;
      const hasReliableSample =
        performanceStatus !== 'INSUFFICIENT_DATA' &&
        e.evaluatedSignals >= MIN_FOR_LIMITED;

      return {
        strategyId: e.strategyId,
        displayName: e.strategyName,
        winRate: e.winRate,
        totalTrades: e.evaluatedSignals,
        averageProfit: detail?.averageWinPct ?? 0,
        averageLoss: Math.abs(detail?.averageLossPct ?? 0),
        bestTrade: detail?.bestReturnPct ?? 0,
        worstTrade: detail?.worstReturnPct ?? 0,
        dataStatus: hasReliableSample ? 'AVAILABLE' as const : 'INSUFFICIENT' as const,
        performanceStatus,
        performanceSource: detail?.performanceSource ?? 'insufficient_data',
        healthLabel: e.healthLabel,
      };
    });

  return {
    rows,
    sourceStatus: {
      directOutcomeRows: direct.length,
      observedSnapshotRows: observed.length,
      backtestTradeRows: backtest.length,
      strategySnapshots: snapshots.size,
      evaluatedTrades: rows.reduce((sum, r) => sum + r.totalTrades, 0),
    },
  };
}
