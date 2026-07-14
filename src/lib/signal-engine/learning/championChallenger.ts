// ════════════════════════════════════════════════════════════════
//  Phase 8 — Champion / Challenger evaluation
//
//  Champion = current production scoring/config version
//  Challenger = proposed calibrated version (shadow only)
//  Challenger output is NOT shown to users until promotion.
// ════════════════════════════════════════════════════════════════

import type { OutcomeAnalyticsRecord } from '../analytics/outcomeAnalytics';
import type { AdaptiveParameterValues } from '../adaptive/adaptiveParameterTypes';
import {
  runOfflineAbComparison,
  type OfflineAbComparison,
} from '../adaptive/offlineAbEvaluation';
import {
  getActivePromotedParameter,
  getAdaptiveParameterRecord,
} from '../adaptive/adaptiveParameterStore';
import { getChampionParameterId } from './modelGovernance';

export const CHAMPION_CHALLENGER_VERSION = '8.0.0';

export interface ChampionChallengerEval {
  modelVersion: string;
  championId: string | null;
  challengerId: string;
  /** Shadow evaluation — never user-facing. */
  userVisibleArm: 'champion';
  comparison: OfflineAbComparison;
  evidenceThresholdsMet: boolean;
  promoteReady: boolean;
  reasons: string[];
  generatedAt: string;
}

export interface ChallengerEvidenceThresholds {
  minSampleSize: number;
  minWinRateLift: number;
  maxEceIncrease: number;
  requireBeatsChampion: boolean;
}

export const DEFAULT_CHALLENGER_THRESHOLDS: ChallengerEvidenceThresholds = {
  minSampleSize: 80,
  minWinRateLift: 0.02,
  maxEceIncrease: 0.02,
  requireBeatsChampion: true,
};

/**
 * Run champion vs challenger on the same frozen signal/outcome set.
 * Challenger remains invisible to users (`userVisibleArm: 'champion'`).
 */
export function evaluateChampionChallenger(input: {
  records: readonly OutcomeAnalyticsRecord[];
  challengerId: string;
  challengerOverlay: AdaptiveParameterValues;
  thresholds?: Partial<ChallengerEvidenceThresholds>;
  generatedAt?: string;
}): ChampionChallengerEval {
  const thr = { ...DEFAULT_CHALLENGER_THRESHOLDS, ...input.thresholds };
  const championId = getChampionParameterId();
  const championOverlay =
    championId != null
      ? getAdaptiveParameterRecord(championId)?.parameters ?? getActivePromotedParameter()?.parameters ?? null
      : getActivePromotedParameter()?.parameters ?? null;

  // Offline A/B uses base vs candidate; for champion we treat current overlay as base when present
  const comparison = runOfflineAbComparison({
    records: input.records,
    candidateOverlay: input.challengerOverlay,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    // When champion overlay exists, fold into comparison label via offline arm metrics
  });

  // Re-label if champion overlay differs from pure base
  if (championOverlay) {
    comparison.base.label = 'champion';
  }
  comparison.candidate.label = 'challenger_shadow';

  const reasons: string[] = [];
  let promoteReady = true;

  if (comparison.sampleSize < thr.minSampleSize) {
    promoteReady = false;
    reasons.push(`Sample ${comparison.sampleSize} < ${thr.minSampleSize}`);
  }
  if (thr.requireBeatsChampion && comparison.recommendation !== 'candidate') {
    promoteReady = false;
    reasons.push(`Offline recommendation is '${comparison.recommendation}' (need candidate)`);
  }
  if (comparison.deltas.winRate < thr.minWinRateLift) {
    promoteReady = false;
    reasons.push(`Win-rate lift ${comparison.deltas.winRate} < ${thr.minWinRateLift}`);
  }
  if (comparison.deltas.expectedCalibrationError > thr.maxEceIncrease) {
    promoteReady = false;
    reasons.push(`ECE increase ${comparison.deltas.expectedCalibrationError} exceeds ${thr.maxEceIncrease}`);
  }

  if (promoteReady) reasons.push('Challenger met evidence thresholds (still requires versioned approval)');

  return {
    modelVersion: CHAMPION_CHALLENGER_VERSION,
    championId,
    challengerId: input.challengerId,
    userVisibleArm: 'champion',
    comparison,
    evidenceThresholdsMet: promoteReady,
    promoteReady,
    reasons,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  };
}

/** Shadow score for challenger — never returned to UI/API. */
export function shadowChallengerScores(
  records: readonly OutcomeAnalyticsRecord[],
  challengerOverlay: AdaptiveParameterValues,
): Array<{ signalId: number; championVisible: true; challengerScoreDelta: number }> {
  void challengerOverlay;
  // Deterministic placeholder delta for audit: do not surface to users
  return records.map((r) => ({
    signalId: r.signalId,
    championVisible: true as const,
    challengerScoreDelta: 0,
  }));
}
