// ════════════════════════════════════════════════════════════════
//  Calibration Metrics — Confidence Bucket Analysis
//
//  Fixed expectedHitRate values are PRIORS only (initial belief).
//  Production / learning calibration uses empiricalCalibration.ts.
//  Backtests still emit suggested modifiers but do not apply them
//  when sample size is below the partial threshold.
// ════════════════════════════════════════════════════════════════

import type { SimulatedTrade, CalibrationBucketResult, CalibrationState, StrategyName, MarketRegimeLabel } from '../types';
import {
  CALIBRATION_HIT_RATE_PRIORS,
  CALIBRATION_MIN_PARTIAL,
  CALIBRATION_MAX_TOTAL_MODIFIER,
} from '@/lib/signal-engine/scoring/empiricalCalibration';

/** Prior tables — not production truth. Kept for bootstrap / thin evidence. */
const CONFIDENCE_BUCKETS = [
  { label: '50_59', low: 50, high: 60, priorHitRate: CALIBRATION_HIT_RATE_PRIORS['50_59'] ?? 0.35 },
  { label: '60_69', low: 60, high: 70, priorHitRate: CALIBRATION_HIT_RATE_PRIORS['60_69'] ?? 0.48 },
  { label: '70_79', low: 70, high: 80, priorHitRate: CALIBRATION_HIT_RATE_PRIORS['70_79'] ?? 0.60 },
  { label: '80_89', low: 80, high: 90, priorHitRate: CALIBRATION_HIT_RATE_PRIORS['80_89'] ?? 0.72 },
  { label: '90_100', low: 90, high: 101, priorHitRate: CALIBRATION_HIT_RATE_PRIORS['90_100'] ?? 0.82 },
];

/**
 * Compute calibration across all confidence buckets.
 * Optionally filter by strategy and/or regime.
 * Modifiers are suggestions only — insufficient samples → modifier 0.
 */
export function computeCalibration(
  trades: SimulatedTrade[],
  strategy: StrategyName | 'all' = 'all',
  regime: MarketRegimeLabel | 'all' = 'all',
): CalibrationBucketResult[] {
  let filtered = trades;
  if (strategy !== 'all') filtered = filtered.filter(t => t.strategy === strategy);
  if (regime !== 'all') filtered = filtered.filter(t => t.regime === regime);

  return CONFIDENCE_BUCKETS.map(bucket => {
    const bucketTrades = filtered.filter(
      t => t.confidenceScore >= bucket.low && t.confidenceScore < bucket.high,
    );
    const n = bucketTrades.length;
    const prior = bucket.priorHitRate;

    if (n < 5) {
      return {
        bucket: bucket.label, strategy, regime,
        sampleSize: n, expectedHitRate: prior,
        actualHitRate: 0, avgMfePct: 0, avgMaePct: 0,
        calibrationState: 'insufficient_data' as CalibrationState,
        confidenceModifierSuggestion: 0,
      };
    }

    const wins = bucketTrades.filter(t => t.target1Hit);
    const actualHitRate = wins.length / n;
    const avgMfePct = bucketTrades.reduce((s, t) => s + t.mfePct, 0) / n;
    const avgMaePct = bucketTrades.reduce((s, t) => s + t.maePct, 0) / n;

    // Assess vs prior; do not materially adjust below partial threshold
    const deviation = actualHitRate - prior;
    let calibrationState: CalibrationState;
    let modifier = 0;

    if (n < CALIBRATION_MIN_PARTIAL) {
      calibrationState = 'insufficient_data';
      modifier = 0;
    } else if (Math.abs(deviation) < 0.08) {
      calibrationState = 'well_calibrated';
      modifier = 0;
    } else if (deviation < -0.15) {
      calibrationState = 'overconfident';
      modifier = -5;
    } else if (deviation < -0.08) {
      calibrationState = 'slightly_overconfident';
      modifier = -2;
    } else if (deviation > 0.08) {
      calibrationState = 'underconfident';
      modifier = 3;
    } else {
      calibrationState = 'well_calibrated';
    }

    modifier = Math.max(-CALIBRATION_MAX_TOTAL_MODIFIER, Math.min(CALIBRATION_MAX_TOTAL_MODIFIER, modifier));

    return {
      bucket: bucket.label, strategy, regime,
      sampleSize: n, expectedHitRate: r(prior),
      actualHitRate: r(actualHitRate),
      avgMfePct: r(avgMfePct), avgMaePct: r(avgMaePct),
      calibrationState, confidenceModifierSuggestion: modifier,
    };
  });
}

/**
 * Compute full calibration matrix: all strategies × all regimes × overall.
 */
export function computeFullCalibrationMatrix(
  trades: SimulatedTrade[],
): CalibrationBucketResult[] {
  const results: CalibrationBucketResult[] = [];

  results.push(...computeCalibration(trades, 'all', 'all'));

  const strategies = Array.from(new Set(trades.map(t => t.strategy)));
  for (const strat of strategies) {
    results.push(...computeCalibration(trades, strat, 'all'));
  }

  const regimes = Array.from(new Set(trades.map(t => t.regime)));
  for (const regime of regimes) {
    results.push(...computeCalibration(trades, 'all', regime));
  }

  return results;
}

/**
 * Quick calibration check: is the model calibrated overall?
 */
export function isModelCalibrated(calibration: CalibrationBucketResult[]): {
  calibrated: boolean;
  overconfidentBuckets: string[];
  underconfidentBuckets: string[];
} {
  const over = calibration.filter(c => c.calibrationState === 'overconfident' || c.calibrationState === 'slightly_overconfident');
  const under = calibration.filter(c => c.calibrationState === 'underconfident');

  return {
    calibrated: over.length === 0 && under.length === 0,
    overconfidentBuckets: over.map(c => `${c.bucket} (${c.strategy}/${c.regime})`),
    underconfidentBuckets: under.map(c => `${c.bucket} (${c.strategy}/${c.regime})`),
  };
}

function r(v: number): number { return Math.round(v * 1000) / 1000; }
