// ════════════════════════════════════════════════════════════════
//  Phase 4 — Derive candidate adaptive parameters from snapshot
// ════════════════════════════════════════════════════════════════

import type { ImmutableLearningSnapshot } from '../learning/versionedLearningSnapshots';
import type { AdaptiveParameterValues } from './adaptiveParameterTypes';

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Deterministic derivation from immutable learning snapshot metrics.
 * Does not modify signal generation — produces versioned overlay only.
 */
export function deriveCandidateParameters(snapshot: ImmutableLearningSnapshot): AdaptiveParameterValues {
  const report = snapshot.benchmarkMetrics;
  const ece = report.confidenceCalibration.expectedCalibrationError;
  const winRate = report.overall.target1HitRate;
  const avgRr = report.overall.avgRealizedRewardRisk ?? 1.2;

  const minRR = clamp(avgRr < 1 ? 1.3 : 1.2, 1.0, 2.0);
  const globalOffset = ece > 0.1 ? -1 : ece < 0.03 ? 0.5 : 0;
  const minLiquidity = winRate < 0.35 ? 60_000 : 50_000;

  return {
    confidenceOffsets: { _global: globalOffset },
    qualityThresholds: winRate < 0.35
      ? { minLiquidityQuality: 45, minTrendStrength: 38 }
      : {},
    rejectionThresholds: {
      minRewardRisk: minRR,
      minLiquidityQuality: winRate < 0.35 ? 38 : 35,
    },
    minLiquidity,
    minAtrPct: 1.5,
    minRewardRisk: minRR,
    featureNormalizationLimits: { min: 0, max: 100 },
  };
}
