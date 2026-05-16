// ════════════════════════════════════════════════════════════════
//  Scoring — Aggregate detector outputs + features into 0–100.
//
//  Design principles:
//   1. Detector scores are the primary signal; features add a small
//      cluster/density boost so repeated behavior compounds.
//   2. No single detector can max out the score alone — we take a
//      weighted blend so surveillance rewards multiple corroborating
//      signals over one loud one.
//   3. Confidence is a multiplier: a 90-score low-confidence detector
//      lands softer than a 70-score high-confidence one.
// ════════════════════════════════════════════════════════════════

import type {
  DetectorResult, ManipulationFeatures, SuspicionBand,
} from '../types';
import { bandFromScore, THRESHOLDS } from '../constants/thresholds';
import { clamp } from '../utils/math';

export interface ScoreResult {
  score: number;
  band: SuspicionBand;
  components: {
    detectorContribution: number;
    clusterContribution: number;
    fragilityContribution: number;
  };
  explanation: string;
}

/** Severity → numeric weight. */
const SEVERITY_WEIGHT: Record<DetectorResult['severity'], number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.8,
  severe: 1.0,
};

export function computeScore(
  detectors: DetectorResult[],
  features: ManipulationFeatures,
): ScoreResult {
  // ── Detector contribution (0–70) ─────────────────────────────
  // Weighted max across triggered detectors, then add a small boost
  // for each additional triggered detector so corroboration counts.
  const triggered = detectors.filter((d) => d.triggered);
  let detectorContribution = 0;
  if (triggered.length > 0) {
    const weighted = triggered.map(
      (d) => d.detectorScore * d.confidence * SEVERITY_WEIGHT[d.severity],
    );
    const top = Math.max(...weighted);
    const corroborationBoost = Math.min(15, (triggered.length - 1) * 5);
    detectorContribution = clamp(top * 0.7 + corroborationBoost, 0, 70);
  }

  // ── Cluster contribution (0–20) ─────────────────────────────
  // Repeated anomalies in the trailing window compound suspicion.
  const clusterContribution = clamp(
    features.anomalyDensity20d * 40 +
      (features.repeatedDistributionPattern ? 5 : 0) +
      (features.repeatedRampPattern ? 5 : 0),
    0,
    20,
  );

  // ── Fragility contribution (0–10) ───────────────────────────
  // Illiquid names get a small floor bump because any manipulation
  // there is structurally more impactful.
  const fragilityContribution = features.illiquidityRiskFlag ? 10 : 0;

  const raw = detectorContribution + clusterContribution + fragilityContribution;
  const score = Math.round(clamp(raw, 0, THRESHOLDS.SCORE_CEILING));
  const bucket = bandFromScore(score);

  // ── Explanation (1-line) ────────────────────────────────────
  const topDetectors = triggered
    .slice()
    .sort((a, b) => b.detectorScore * b.confidence - a.detectorScore * a.confidence)
    .slice(0, 2)
    .map((d) => d.detectorLabel);

  const explanation = triggered.length === 0
    ? `${bucket.label}: no detectors triggered`
    : `${bucket.label}: ${topDetectors.join('; ')}`;

  return {
    score,
    band: bucket.band,
    components: {
      detectorContribution: Math.round(detectorContribution),
      clusterContribution: Math.round(clusterContribution),
      fragilityContribution,
    },
    explanation,
  };
}
