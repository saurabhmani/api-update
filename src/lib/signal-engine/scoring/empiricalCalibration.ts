// ════════════════════════════════════════════════════════════════
//  Empirical Confidence Calibration — Product A Phase 2
//
//  Production calibration uses empirical outcomes. Fixed hit-rate
//  tables are PRIORS only (initial / insufficient-data fallback).
//  Hierarchy + shrinkage toward parent cells. Bounded apply policy.
// ════════════════════════════════════════════════════════════════

import type { StrategyName, MarketRegimeLabel } from '../types/signalEngine.types';

export const CONFIDENCE_MODEL_VERSION = '2.0.0';

/** Prior hit rates — NOT production truth; used only when evidence is thin. */
export const CALIBRATION_HIT_RATE_PRIORS: Record<string, number> = {
  '85_100': 0.72,
  '70_84': 0.60,
  '55_69': 0.48,
  '0_54': 0.30,
  '90_100': 0.82,
  '80_89': 0.72,
  '70_79': 0.60,
  '60_69': 0.48,
  '50_59': 0.35,
};

export const CALIBRATION_MIN_TRUSTED = 100;
export const CALIBRATION_MIN_PARTIAL = 40;
/** Hard caps — Phase 2.5 */
export const CALIBRATION_MAX_TOTAL_MODIFIER = 8;
export const CALIBRATION_MAX_CYCLE_DELTA = 1;

export type EmpiricalCalibrationState =
  | 'well_calibrated'
  | 'overconfident'
  | 'underconfident'
  | 'insufficient_data';

export interface EmpiricalOutcomeRow {
  confidenceScore: number;
  strategy: string;
  regime: string;
  volatilityState?: string | null;
  target1Hit: boolean;
  entryTriggered: boolean;
  expired?: boolean;
  maxFavorableExcursionPct?: number;
  maxAdverseExcursionPct?: number;
  /** Optional for Brier: predicted probability in [0,1] */
  predictedProbability?: number | null;
}

export interface EmpiricalBucketMetrics {
  bucket: string;
  strategy: string | null;
  regime: string | null;
  volatilityState: string | null;
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
  calibrationState: EmpiricalCalibrationState;
  /** Suggested bounded modifier before cycle/total caps (points on 0–100 score). */
  suggestedModifier: number;
  /** Weight in [0,1] for shrinkage toward parent. */
  evidenceWeight: number;
}

export interface CalibrationCellKey {
  bucket: string;
  strategy?: string | null;
  regime?: string | null;
  volatilityState?: string | null;
}

function wilsonInterval(wins: number, n: number, z = 1.96): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 0 };
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom),
  };
}

export function confidenceBucketForScore(score: number): string {
  if (score >= 85) return '85_100';
  if (score >= 70) return '70_84';
  if (score >= 55) return '55_69';
  return '0_54';
}

export function computeEmpiricalBucketMetrics(
  bucket: string,
  rows: EmpiricalOutcomeRow[],
  dims: { strategy?: string | null; regime?: string | null; volatilityState?: string | null } = {},
): EmpiricalBucketMetrics {
  const prior = CALIBRATION_HIT_RATE_PRIORS[bucket] ?? 0.5;
  const n = rows.length;
  if (n === 0) {
    return {
      bucket,
      strategy: dims.strategy ?? null,
      regime: dims.regime ?? null,
      volatilityState: dims.volatilityState ?? null,
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
      suggestedModifier: 0,
      evidenceWeight: 0,
    };
  }

  const wins = rows.filter((r) => r.target1Hit).length;
  const actual = wins / n;
  const wil = wilsonInterval(wins, n);
  const avgMfe = rows.reduce((s, r) => s + (r.maxFavorableExcursionPct ?? 0), 0) / n;
  const avgMae = rows.reduce((s, r) => s + (r.maxAdverseExcursionPct ?? 0), 0) / n;
  const entryTriggerRate = rows.filter((r) => r.entryTriggered).length / n;
  const expiryRate = rows.filter((r) => r.expired).length / n;

  let brier: number | null = null;
  const withPred = rows.filter((r) => r.predictedProbability != null && Number.isFinite(r.predictedProbability));
  if (withPred.length > 0) {
    brier = withPred.reduce((s, r) => {
      const p = r.predictedProbability as number;
      const y = r.target1Hit ? 1 : 0;
      return s + (p - y) ** 2;
    }, 0) / withPred.length;
  }

  // ECE proxy: |actual − prior| when no multi-bin curve available for the cell
  const ece = Math.abs(actual - prior);

  let evidenceWeight = 0;
  if (n >= CALIBRATION_MIN_TRUSTED) evidenceWeight = 1;
  else if (n >= CALIBRATION_MIN_PARTIAL) {
    evidenceWeight = (n - CALIBRATION_MIN_PARTIAL) / (CALIBRATION_MIN_TRUSTED - CALIBRATION_MIN_PARTIAL);
    evidenceWeight = Math.max(0.25, Math.min(0.9, evidenceWeight));
  }

  let calibrationState: EmpiricalCalibrationState = 'insufficient_data';
  let suggestedModifier = 0;
  if (n >= CALIBRATION_MIN_PARTIAL) {
    const deviation = actual - prior;
    if (Math.abs(deviation) < 0.08) {
      calibrationState = 'well_calibrated';
      suggestedModifier = 0;
    } else if (deviation < -0.08) {
      calibrationState = 'overconfident';
      suggestedModifier = Math.round(deviation * 20 * evidenceWeight); // up to ~−4 at full weight
    } else {
      calibrationState = 'underconfident';
      suggestedModifier = Math.round(deviation * 20 * evidenceWeight);
    }
    suggestedModifier = clampInt(suggestedModifier, -CALIBRATION_MAX_TOTAL_MODIFIER, CALIBRATION_MAX_TOTAL_MODIFIER);
  }

  return {
    bucket,
    strategy: dims.strategy ?? null,
    regime: dims.regime ?? null,
    volatilityState: dims.volatilityState ?? null,
    sampleSize: n,
    actualPrecision: round4(actual),
    priorHitRate: prior,
    wilsonLower: round4(wil.lower),
    wilsonUpper: round4(wil.upper),
    brierScore: brier == null ? null : round4(brier),
    expectedCalibrationError: round4(ece),
    avgMfe: round4(avgMfe),
    avgMae: round4(avgMae),
    entryTriggerRate: round4(entryTriggerRate),
    expiryRate: round4(expiryRate),
    calibrationState,
    suggestedModifier,
    evidenceWeight,
  };
}

/**
 * Hierarchy: strategy+regime+vol → strategy+regime → strategy → bucket → none.
 * Shrink small cells toward parent suggested modifier.
 */
export function resolveCalibrationHierarchy(
  score: number,
  strategy: StrategyName | string,
  regime: MarketRegimeLabel | string,
  volatilityState: string | null | undefined,
  cells: EmpiricalBucketMetrics[],
): {
  cell: EmpiricalBucketMetrics | null;
  appliedModifier: number;
  calibratedProbability: number | null;
  level: string;
} {
  const bucket = confidenceBucketForScore(score);
  const prior = CALIBRATION_HIT_RATE_PRIORS[bucket] ?? 0.5;

  const find = (
    s: string | null,
    r: string | null,
    v: string | null,
  ): EmpiricalBucketMetrics | undefined =>
    cells.find(
      (c) =>
        c.bucket === bucket &&
        (c.strategy ?? null) === s &&
        (c.regime ?? null) === r &&
        (c.volatilityState ?? null) === v,
    );

  const levels: Array<{ level: string; cell?: EmpiricalBucketMetrics }> = [
    { level: 'strategy_regime_vol', cell: find(strategy, regime, volatilityState ?? null) },
    { level: 'strategy_regime', cell: find(strategy, regime, null) },
    { level: 'strategy', cell: find(strategy, null, null) },
    { level: 'bucket', cell: find(null, null, null) },
  ];

  let chosen: EmpiricalBucketMetrics | null = null;
  let level = 'none';
  let parentModifier = 0;
  for (const L of levels) {
    if (!L.cell) continue;
    if (L.cell.sampleSize < CALIBRATION_MIN_PARTIAL) {
      // Informational only — remember parent when trusted later
      if (L.cell.sampleSize >= 10) parentModifier = L.cell.suggestedModifier;
      continue;
    }
    chosen = L.cell;
    level = L.level;
    // Shrink toward broader parent if not fully trusted
    if (chosen.evidenceWeight < 1) {
      const parent = levels.slice(levels.indexOf(L) + 1).find((x) => x.cell && x.cell.sampleSize >= CALIBRATION_MIN_PARTIAL)?.cell;
      const parentSug = parent?.suggestedModifier ?? parentModifier;
      const w = chosen.evidenceWeight;
      const blended = Math.round(w * chosen.suggestedModifier + (1 - w) * parentSug);
      chosen = { ...chosen, suggestedModifier: blended };
    }
    break;
  }

  if (!chosen || chosen.calibrationState === 'insufficient_data') {
    return {
      cell: chosen,
      appliedModifier: 0,
      calibratedProbability: null,
      level: 'none',
    };
  }

  const applied = clampInt(chosen.suggestedModifier, -CALIBRATION_MAX_TOTAL_MODIFIER, CALIBRATION_MAX_TOTAL_MODIFIER);
  // Calibrated probability: shrink empirical precision toward prior
  const p =
    chosen.evidenceWeight * chosen.actualPrecision +
    (1 - chosen.evidenceWeight) * prior;

  return {
    cell: chosen,
    appliedModifier: applied,
    calibratedProbability: round4(p),
    level,
  };
}

/** Cap cycle change vs previous stored modifier. */
export function applyCycleBound(
  previousModifier: number,
  proposedModifier: number,
  maxDelta = CALIBRATION_MAX_CYCLE_DELTA,
): number {
  const delta = proposedModifier - previousModifier;
  const bounded = clampInt(delta, -maxDelta, maxDelta);
  return clampInt(previousModifier + bounded, -CALIBRATION_MAX_TOTAL_MODIFIER, CALIBRATION_MAX_TOTAL_MODIFIER);
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** In-memory cell store for production lookups (filled by learning job). */
let cachedCells: EmpiricalBucketMetrics[] = [];

export function setCalibrationCellCache(cells: EmpiricalBucketMetrics[]): void {
  cachedCells = cells;
}

export function getCalibrationCellCache(): EmpiricalBucketMetrics[] {
  return cachedCells;
}
