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
  type PerformanceWindow,
} from '@/lib/strategies/strategyPerformance';
import type { TrustStrategyPerformanceRow } from '../types';

export async function loadTrustStrategyPerformance(
  window: PerformanceWindow = '90D',
): Promise<TrustStrategyPerformanceRow[]> {
  const w = VALID_WINDOWS.has(window) ? window : '90D';

  const [direct, observed, backtest, snapshots] = await Promise.all([
    loadDirectSignalOutcomes(w),
    loadObservedOutcomes(w),
    loadBacktestOutcomes(w),
    loadStrategyPerformanceSnapshots(w),
  ]);

  const deduped = dedupeOutcomesBySignal([...direct, ...observed, ...backtest]);
  const { report } = buildPerformanceReport(deduped, w, snapshots);

  return report.strategies.map((s) => ({
    strategyId: s.strategyId,
    displayName: s.strategyName,
    winRate: s.winRate,
    totalTrades: s.evaluatedSignals,
    averageProfit: s.averageWinPct,
    averageLoss: s.averageLossPct,
    bestTrade: s.bestReturnPct,
    worstTrade: s.worstReturnPct,
    dataStatus: s.evaluatedSignals >= 3 ? 'AVAILABLE' as const : 'INSUFFICIENT' as const,
  }));
}
