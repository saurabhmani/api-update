// ════════════════════════════════════════════════════════════════
//  Confidence Reliability Report — Product A Phase 2
//
//  Summarises empirical bucket health for operators and acceptance
//  checks (monotonicity, sample coverage, calibration state).
// ════════════════════════════════════════════════════════════════

import type { EmpiricalBucketMetrics } from './empiricalCalibration';
import {
  CALIBRATION_HIT_RATE_PRIORS,
  CALIBRATION_MIN_PARTIAL,
  CALIBRATION_MIN_TRUSTED,
  CONFIDENCE_MODEL_VERSION,
  confidenceBucketForScore,
} from './empiricalCalibration';
import { ELITE_PRECISION_TARGET } from './signalConfidenceTiers';

export interface BucketReliabilityRow {
  bucket: string;
  sampleSize: number;
  actualPrecision: number;
  priorHitRate: number;
  wilsonLower: number;
  wilsonUpper: number;
  brierScore: number | null;
  expectedCalibrationError: number | null;
  avgMfe: number;
  avgMae: number;
  entryTriggerRate: number;
  expiryRate: number;
  calibrationState: string;
  evidenceLabel: string;
}

export interface ConfidenceReliabilityReport {
  modelVersion: string;
  generatedAt: string;
  elitePrecisionTarget: number;
  minTrustedSample: number;
  minPartialSample: number;
  overallBuckets: BucketReliabilityRow[];
  /** Higher calibrated bucket must not systematically underperform lower. */
  monotonicityOk: boolean;
  monotonicityNotes: string[];
  insufficientEvidenceBuckets: string[];
  overconfidentBuckets: string[];
  underconfidentBuckets: string[];
  cellCount: number;
  trustedCellCount: number;
}

function toRow(m: EmpiricalBucketMetrics): BucketReliabilityRow {
  const evidenceLabel =
    m.sampleSize <= 0
      ? 'insufficient_evidence'
      : m.sampleSize < CALIBRATION_MIN_PARTIAL
        ? `insufficient_evidence (n=${m.sampleSize})`
        : `n=${m.sampleSize}`;
  return {
    bucket: m.bucket,
    sampleSize: m.sampleSize,
    actualPrecision: m.actualPrecision,
    priorHitRate: m.priorHitRate,
    wilsonLower: m.wilsonLower,
    wilsonUpper: m.wilsonUpper,
    brierScore: m.brierScore,
    expectedCalibrationError: m.expectedCalibrationError,
    avgMfe: m.avgMfe,
    avgMae: m.avgMae,
    entryTriggerRate: m.entryTriggerRate,
    expiryRate: m.expiryRate,
    calibrationState: m.calibrationState,
    evidenceLabel,
  };
}

/** Canonical score-order for overall confidence buckets. */
const BUCKET_ORDER = ['0_54', '55_69', '70_84', '85_100'] as const;

/**
 * Build operator-facing reliability report from empirical cells.
 * Prefer overall (strategy/regime/vol null) rows for monotonicity.
 */
export function buildConfidenceReliabilityReport(
  cells: EmpiricalBucketMetrics[],
  generatedAt = new Date().toISOString(),
): ConfidenceReliabilityReport {
  const overall = cells.filter(
    (c) => c.strategy == null && c.regime == null && c.volatilityState == null,
  );
  const byBucket = new Map(overall.map((c) => [c.bucket, c]));

  const overallBuckets: BucketReliabilityRow[] = BUCKET_ORDER.map((b) => {
    const existing = byBucket.get(b);
    if (existing) return toRow(existing);
    const prior = CALIBRATION_HIT_RATE_PRIORS[b] ?? 0.5;
    return {
      bucket: b,
      sampleSize: 0,
      actualPrecision: 0,
      priorHitRate: prior,
      wilsonLower: 0,
      wilsonUpper: 0,
      brierScore: null,
      expectedCalibrationError: null,
      avgMfe: 0,
      avgMae: 0,
      entryTriggerRate: 0,
      expiryRate: 0,
      calibrationState: 'insufficient_data',
      evidenceLabel: 'insufficient_evidence',
    };
  });

  const monotonicityNotes: string[] = [];
  let monotonicityOk = true;
  const comparable = overallBuckets.filter((r) => r.sampleSize >= CALIBRATION_MIN_PARTIAL);
  for (let i = 1; i < comparable.length; i++) {
    const prev = comparable[i - 1];
    const cur = comparable[i];
    if (cur.actualPrecision + 0.02 < prev.actualPrecision) {
      monotonicityOk = false;
      monotonicityNotes.push(
        `${cur.bucket} precision ${cur.actualPrecision} underperforms ${prev.bucket} ${prev.actualPrecision}`,
      );
    }
  }
  if (comparable.length < 2) {
    monotonicityNotes.push('insufficient comparable buckets for monotonicity check');
  }

  return {
    modelVersion: CONFIDENCE_MODEL_VERSION,
    generatedAt,
    elitePrecisionTarget: ELITE_PRECISION_TARGET,
    minTrustedSample: CALIBRATION_MIN_TRUSTED,
    minPartialSample: CALIBRATION_MIN_PARTIAL,
    overallBuckets,
    monotonicityOk,
    monotonicityNotes,
    insufficientEvidenceBuckets: overallBuckets
      .filter((r) => r.sampleSize < CALIBRATION_MIN_PARTIAL)
      .map((r) => r.bucket),
    overconfidentBuckets: overallBuckets
      .filter((r) => r.calibrationState === 'overconfident')
      .map((r) => r.bucket),
    underconfidentBuckets: overallBuckets
      .filter((r) => r.calibrationState === 'underconfident')
      .map((r) => r.bucket),
    cellCount: cells.length,
    trustedCellCount: cells.filter((c) => c.sampleSize >= CALIBRATION_MIN_TRUSTED).length,
  };
}

/** Compare baseline vs revised scores on the same frozen dataset of outcomes. */
export function compareBaselineVsRevisedScoring(input: {
  outcomes: Array<{ confidenceScore: number; target1Hit: boolean }>;
  reviseScore: (raw: number) => number;
}): {
  baselinePrecisionByBucket: Record<string, number>;
  revisedPrecisionByBucket: Record<string, number>;
  sameFrozenN: number;
} {
  const baseline: Record<string, { wins: number; n: number }> = {};
  const revised: Record<string, { wins: number; n: number }> = {};
  for (const o of input.outcomes) {
    const bBucket = confidenceBucketForScore(o.confidenceScore);
    const rBucket = confidenceBucketForScore(input.reviseScore(o.confidenceScore));
    baseline[bBucket] ??= { wins: 0, n: 0 };
    revised[rBucket] ??= { wins: 0, n: 0 };
    baseline[bBucket].n++;
    revised[rBucket].n++;
    if (o.target1Hit) {
      baseline[bBucket].wins++;
      revised[rBucket].wins++;
    }
  }
  const toPrec = (m: Record<string, { wins: number; n: number }>) =>
    Object.fromEntries(
      Object.entries(m).map(([k, v]) => [k, v.n === 0 ? 0 : Math.round((v.wins / v.n) * 10000) / 10000]),
    );
  return {
    baselinePrecisionByBucket: toPrec(baseline),
    revisedPrecisionByBucket: toPrec(revised),
    sameFrozenN: input.outcomes.length,
  };
}
