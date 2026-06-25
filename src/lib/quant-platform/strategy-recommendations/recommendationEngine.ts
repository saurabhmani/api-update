// Strategy Recommendation Engine — regime-aware, ranked, confidence-scored

import { buildRegimeRouter } from '@/lib/strategies/regimeRouter';
import { getLatestRegime } from '@/lib/signal-engine/repository/readSignals';
import { loadObservedOutcomes, buildPerformanceReport } from '@/lib/strategies/strategyPerformance';
import type { StrategyRecommendation } from '../types';
import { saveRecommendations } from '../repository/quantRepository';

const ACTION_PRIORITY: Record<StrategyRecommendation['action'], number> = {
  PROMOTE: 5,
  ACTIVE: 4,
  REDUCE: 3,
  WATCHLIST_ONLY: 2,
  BLOCK: 1,
};

export async function getStrategyRecommendations(userId?: number): Promise<{
  regime: string;
  regimeStatus: string;
  recommendations: StrategyRecommendation[];
  ranking: StrategyRecommendation[];
  overallConfidence: number;
}> {
  const regimeLabel = await getLatestRegime().catch(() => 'unknown');
  const outcomes = await loadObservedOutcomes('90D').catch(() => []);
  const perfReport = buildPerformanceReport(outcomes, '90D');

  const routing = buildRegimeRouter({
    detectedRegime: regimeLabel !== 'unknown' ? (regimeLabel as any) : null,
    regimeStrength: null,
    benchmarkAgeMinutes: null,
    performances: perfReport.report.strategies,
    performanceWindow: '90D',
  });

  const perfMap = new Map(perfReport.report.strategies.map((s) => [s.strategyId, s]));

  const recommendations: StrategyRecommendation[] = routing.routingMatrix.map((d) => {
    const perf = perfMap.get(d.strategyId);
    const baseConf = d.routingDecision === 'PROMOTE' ? 85
      : d.routingDecision === 'ACTIVE' ? 70
        : d.routingDecision === 'REDUCE' ? 45
          : d.routingDecision === 'BLOCK' ? 15 : 35;

    const explainability = [
      d.reason,
      `Regime: ${d.regime}`,
      `Routing: ${d.routingDecision}`,
      ...(d.warnings ?? []),
    ];
    if (perf) {
      explainability.push(
        `90D win rate: ${perf.winRate ?? 'N/A'}%, health: ${perf.healthLabel ?? 'N/A'}`,
        `Evaluated signals: ${perf.evaluatedSignals ?? 0}`,
      );
    }

    return {
      rank: 0,
      strategyId: d.strategyId,
      strategyName: d.strategyName,
      action: d.routingDecision as StrategyRecommendation['action'],
      confidence: Math.max(0, Math.min(100, baseConf + d.confidenceAdjustment)),
      regime: d.regime,
      reason: d.reason,
      explainability,
    };
  });

  // Strategy ranking: action priority first, then confidence
  const ranking = [...recommendations].sort((a, b) => {
    const ap = ACTION_PRIORITY[a.action] ?? 0;
    const bp = ACTION_PRIORITY[b.action] ?? 0;
    if (bp !== ap) return bp - ap;
    return b.confidence - a.confidence;
  }).map((r, i) => ({ ...r, rank: i + 1 }));

  const overallConfidence = ranking.length
    ? Math.round(ranking.reduce((s, r) => s + r.confidence, 0) / ranking.length)
    : routing.confidence;

  await saveRecommendations(userId ?? null, routing.currentRegime, ranking, overallConfidence);

  return {
    regime: routing.currentRegime,
    regimeStatus: routing.regimeStatus,
    recommendations: ranking,
    ranking,
    overallConfidence,
  };
}
