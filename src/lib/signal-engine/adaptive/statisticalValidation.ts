// ════════════════════════════════════════════════════════════════
//  Phase 4 — Statistical Validation (promotion gate)
// ════════════════════════════════════════════════════════════════

import type { OutcomeAnalyticsRecord } from '../analytics/outcomeAnalytics';
import type { ValidationMetrics } from './adaptiveParameterTypes';

export interface ValidationThresholds {
  minSampleSize: number;
  minWinCount: number;
  minStabilityScore: number;
  maxOutlierRate: number;
  minEffectSize: number;
  confidenceLevel: number;
}

export const DEFAULT_VALIDATION_THRESHOLDS: ValidationThresholds = {
  minSampleSize: 100,
  minWinCount: 30,
  minStabilityScore: 0.7,
  maxOutlierRate: 0.15,
  minEffectSize: 0.05,
  confidenceLevel: 0.95,
};

function isWin(record: OutcomeAnalyticsRecord): boolean {
  return record.outcome.target1Hit && record.outcome.exitReason !== 'stop';
}

function wilsonInterval(wins: number, n: number, level: number): { lower: number; upper: number } {
  if (n === 0) return { lower: 0, upper: 0 };
  const z = level >= 0.95 ? 1.96 : 1.645;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return {
    lower: Math.max(0, (centre - margin) / denom),
    upper: Math.min(1, (centre + margin) / denom),
  };
}

function outlierRate(values: number[]): number {
  if (values.length < 4) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  if (iqr <= 0) return 0;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return values.filter((v) => v < lo || v > hi).length / values.length;
}

function stabilityAcrossWindows(records: readonly OutcomeAnalyticsRecord[]): number {
  if (records.length < 20) return 0;
  const ordered = [...records].sort((a, b) =>
    a.generatedAt.localeCompare(b.generatedAt) || a.signalId - b.signalId,
  );
  const mid = Math.floor(ordered.length / 2);
  const first = ordered.slice(0, mid);
  const second = ordered.slice(mid);
  const rate = (rows: OutcomeAnalyticsRecord[]) =>
    rows.length === 0 ? 0 : rows.filter(isWin).length / rows.length;
  const r1 = rate(first);
  const r2 = rate(second);
  const delta = Math.abs(r1 - r2);
  return Math.max(0, 1 - delta * 2);
}

/**
 * Validate training evidence before any adaptive parameter may advance
 * in the promotion pipeline.
 */
export function validateAdaptiveEvidence(
  records: readonly OutcomeAnalyticsRecord[],
  thresholds: ValidationThresholds = DEFAULT_VALIDATION_THRESHOLDS,
): ValidationMetrics {
  const n = records.length;
  const wins = records.filter(isWin).length;
  const winRate = n === 0 ? 0 : wins / n;
  const interval = wilsonInterval(wins, n, thresholds.confidenceLevel);
  const pnl = records.map((r) => r.outcome.realizedRewardRisk ?? r.outcome.pnlR);
  const meanPnl = pnl.length === 0 ? 0 : pnl.reduce((s, v) => s + v, 0) / pnl.length;
  const effectSize = Math.abs(meanPnl);
  const stabilityScore = stabilityAcrossWindows(records);
  const outliers = outlierRate(pnl);

  const rejectionReasons: string[] = [];
  if (n < thresholds.minSampleSize) rejectionReasons.push(`sample_size ${n} < ${thresholds.minSampleSize}`);
  if (wins < thresholds.minWinCount) rejectionReasons.push(`win_count ${wins} < ${thresholds.minWinCount}`);
  if (stabilityScore < thresholds.minStabilityScore) {
    rejectionReasons.push(`stability ${stabilityScore.toFixed(3)} < ${thresholds.minStabilityScore}`);
  }
  if (outliers > thresholds.maxOutlierRate) {
    rejectionReasons.push(`outlier_rate ${outliers.toFixed(3)} > ${thresholds.maxOutlierRate}`);
  }
  if (effectSize < thresholds.minEffectSize) {
    rejectionReasons.push(`effect_size ${effectSize.toFixed(3)} < ${thresholds.minEffectSize}`);
  }

  return {
    sampleSize: n,
    winCount: wins,
    winRate: Math.round(winRate * 10000) / 10000,
    confidenceInterval: {
      level: thresholds.confidenceLevel,
      lower: Math.round(interval.lower * 10000) / 10000,
      upper: Math.round(interval.upper * 10000) / 10000,
    },
    effectSize: Math.round(effectSize * 10000) / 10000,
    stabilityScore: Math.round(stabilityScore * 10000) / 10000,
    outlierRate: Math.round(outliers * 10000) / 10000,
    passed: rejectionReasons.length === 0,
    rejectionReasons,
  };
}
