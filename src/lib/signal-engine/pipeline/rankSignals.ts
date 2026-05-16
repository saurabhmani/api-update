// ════════════════════════════════════════════════════════════════
//  Signal Ranking — Phase 1
// ════════════════════════════════════════════════════════════════

import type { QuantSignal } from '../types/signalEngine.types';

export function rankSignals(signals: QuantSignal[]): QuantSignal[] {
  // Filter out "Avoid" band signals from ranking
  const rankable = signals.filter((s) => s.confidenceBand !== 'Avoid');
  const excluded = signals.filter((s) => s.confidenceBand === 'Avoid');

  const scored = rankable.map((s) => ({
    signal: s,
    compositeScore: computeRankScore(s),
  }));

  scored.sort((a, b) => b.compositeScore - a.compositeScore);

  const ranked = scored.map((item, index) => ({
    ...item.signal,
    rank: index + 1,
  }));

  // Append excluded with rank = 0 (not ranked)
  const unranked = excluded.map((s) => ({ ...s, rank: 0 }));

  return [...ranked, ...unranked];
}

function computeRankScore(s: QuantSignal): number {
  // Weighted composite: confidence (35%), inverse risk (20%), volume (15%), structure (15%), R:R (15%)
  const confidenceComponent = s.confidenceScore * 0.35;
  const riskComponent = (100 - s.riskScore) * 0.20;

  // Logarithmic volume scaling (handles wide range without capping at 5x)
  const volRatio = Math.max(1, s.features.volume.volumeVs20dAvg);
  const volumeComponent = Math.min(Math.log(volRatio) / Math.log(10) * 50, 100) * 0.15;

  // Structure score based on breakout distance
  const bDist = s.features.structure.breakoutDistancePct;
  const structureScore = bDist > 0 && bDist <= 2 ? 90
    : bDist > 0 && bDist <= 3 ? 75
    : bDist > 0 && bDist <= 5 ? 50
    : 20;
  const structureComponent = structureScore * 0.15;

  // Reward/Risk ratio component
  const rrScore = Math.min(s.rewardRiskApprox * 30, 100);
  const rrComponent = rrScore * 0.15;

  return confidenceComponent + riskComponent + volumeComponent + structureComponent + rrComponent;
}
