// ════════════════════════════════════════════════════════════════
//  Phase 2 — Confidence Calibration
//
//  Augments scoreConfidenceForStrategy() — does NOT replace it.
//  Calibration adjustments are bounded and config-gated.
// ════════════════════════════════════════════════════════════════

import type {
  SignalFeatures,
  ConfidenceBreakdown,
  StrategyName,
  RelativeStrengthFeatures,
} from '../types/signalEngine.types';
import { getRuntimeSignalEngineConfig } from '../adaptive/runtimeConfiguration';
import { clamp } from '../utils/math';
import {
  CONFIDENCE_HIGH_CONVICTION,
  CONFIDENCE_ACTIONABLE,
  CONFIDENCE_WATCHLIST,
} from '../constants/signalEngine.constants';
import type { ConfidenceBand } from '../types/signalEngine.types';

function classifyConfidence(score: number): ConfidenceBand {
  if (score >= CONFIDENCE_HIGH_CONVICTION) return 'High Conviction';
  if (score >= CONFIDENCE_ACTIONABLE) return 'Actionable';
  if (score >= CONFIDENCE_WATCHLIST) return 'Watchlist';
  return 'Avoid';
}

export interface ConfidenceValidationResult {
  valid: boolean;
  issues: string[];
}

/** Validate inputs before confidence scoring. */
export function validateConfidenceInputs(
  features: SignalFeatures,
): ConfidenceValidationResult {
  const issues: string[] = [];
  const e = features.enhanced;

  if (!features.context.liquidityPass) {
    issues.push('Liquidity filter failed — avg volume or price below minimum');
  }
  if (features.momentum.rsi14 < 0 || features.momentum.rsi14 > 100) {
    issues.push(`RSI out of range: ${features.momentum.rsi14}`);
  }
  if (e && e.trendExhaustion > 85) {
    issues.push(`Trend exhaustion elevated (${e.trendExhaustion}/100)`);
  }
  if (e && e.liquidityQuality < 25) {
    issues.push(`Liquidity quality very low (${e.liquidityQuality}/100)`);
  }

  return { valid: issues.length === 0, issues };
}

/**
 * Bounded Phase 2 calibration adjustment from enhanced features.
 * Returns 0 when config version=1 or calibration disabled.
 */
export function computePhase2ConfidenceAdjustment(
  features: SignalFeatures,
  strategy: StrategyName,
): number {
  const config = getRuntimeSignalEngineConfig().config;
  if (config.version < 2 || !config.confidence.enabled) return 0;

  const e = features.enhanced;
  if (!e) return 0;

  const { maxAdjustment, minEnhancedTrendForBonus, minEnhancedVolumeForBonus, maxTrendExhaustionPenalty } =
    config.confidence;

  let adj = 0;

  if (e.trendStrength >= minEnhancedTrendForBonus) adj += 2;
  if (e.volumeQuality >= minEnhancedVolumeForBonus) adj += 1;
  if (e.momentumPersistence >= 60) adj += 1;
  if (e.multiTimeframeAlignment >= 70) adj += 1;
  if (e.relativeStrength >= 65) adj += 1;

  if (e.trendExhaustion >= maxTrendExhaustionPenalty) adj -= 3;
  if (e.volatilityRegime < 30) adj -= 2;
  if (e.breakoutQuality < 30 && strategy === 'bullish_breakout') adj -= 2;
  if (e.liquidityQuality < 35) adj -= 2;

  return clamp(adj, -maxAdjustment, maxAdjustment);
}

/** Build human-readable confidence explanation lines. */
export function buildConfidenceExplanation(
  breakdown: ConfidenceBreakdown,
  features: SignalFeatures,
  strategy: StrategyName,
  rs: RelativeStrengthFeatures,
  adjustment: number,
): string[] {
  const lines: string[] = [
    `Setup confidence ${breakdown.finalScore}/100 (${breakdown.band}) for ${strategy}`,
    `Components — trend ${breakdown.trendScore}, momentum ${breakdown.momentumScore}, volume ${breakdown.volumeScore}, structure ${breakdown.structureScore}, context ${breakdown.contextScore}`,
  ];

  if (breakdown.penaltyScore > 0) {
    lines.push(`Penalties applied: -${breakdown.penaltyScore} (overextension, volatility, regime, or divergence)`);
  }

  const e = features.enhanced;
  if (e) {
    lines.push(
      `Enhanced inputs — trend strength ${e.trendStrength}, volume quality ${e.volumeQuality}, momentum persistence ${e.momentumPersistence}, MTF alignment ${e.multiTimeframeAlignment}`,
    );
    if (adjustment !== 0) {
      lines.push(`Phase 2 calibration adjustment: ${adjustment >= 0 ? '+' : ''}${adjustment}`);
    }
  }

  if (rs.rsVsIndex !== 0) {
    lines.push(`Relative strength vs index: ${rs.rsVsIndex.toFixed(1)}%`);
  }

  return lines;
}

/** Apply Phase 2 calibration to an existing confidence breakdown. */
export function applyPhase2ConfidenceCalibration(
  breakdown: ConfidenceBreakdown,
  features: SignalFeatures,
  strategy: StrategyName,
): ConfidenceBreakdown {
  const adjustment = computePhase2ConfidenceAdjustment(features, strategy);
  if (adjustment === 0) return breakdown;

  const adjusted = clamp(breakdown.finalScore + adjustment, 0, 100);
  return {
    ...breakdown,
    finalScore: adjusted,
    band: classifyConfidence(adjusted),
  };
}
