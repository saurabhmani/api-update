// ════════════════════════════════════════════════════════════════
//  Phase 4 — Drift Detection (alerts only — no auto-modify)
// ════════════════════════════════════════════════════════════════

import type { ImmutableLearningSnapshot } from '../learning/versionedLearningSnapshots';
import type { OutcomeAnalyticsRecord } from '../analytics/outcomeAnalytics';
import { logAdaptiveAudit } from './learningAudit';

export type DriftCategory =
  | 'confidence_drift'
  | 'strategy_drift'
  | 'feature_drift'
  | 'market_regime_drift'
  | 'performance_drift'
  // Phase 8 expansions
  | 'precision_drift'
  | 'calibration_drift'
  | 'entry_trigger_drift'
  | 'mfe_mae_drift'
  | 'regime_distribution_drift'
  | 'strategy_mix_drift'
  | 'data_quality_drift';

export interface DriftAlert {
  category: DriftCategory;
  severity: 'low' | 'medium' | 'high';
  message: string;
  baselineValue: number;
  currentValue: number;
  delta: number;
  detectedAt: string;
}

export interface DriftDetectionReport {
  baselineSnapshotId: string;
  currentSnapshotId: string;
  alerts: DriftAlert[];
  alertCount: number;
}

function severity(delta: number, low: number, high: number): DriftAlert['severity'] {
  const abs = Math.abs(delta);
  if (abs >= high) return 'high';
  if (abs >= low) return 'medium';
  return 'low';
}

/**
 * Compare two immutable snapshots and emit alerts only.
 * Does NOT modify adaptive parameters or signal generation.
 */
export function detectDrift(
  baseline: ImmutableLearningSnapshot,
  current: ImmutableLearningSnapshot,
  detectedAt = new Date().toISOString(),
): DriftDetectionReport {
  const alerts: DriftAlert[] = [];
  const b = baseline.benchmarkMetrics;
  const c = current.benchmarkMetrics;

  const eceDelta = c.confidenceCalibration.expectedCalibrationError
    - b.confidenceCalibration.expectedCalibrationError;
  if (Math.abs(eceDelta) >= 0.02) {
    alerts.push({
      category: 'confidence_drift',
      severity: severity(eceDelta, 0.03, 0.08),
      message: `ECE shifted by ${eceDelta.toFixed(4)}`,
      baselineValue: b.confidenceCalibration.expectedCalibrationError,
      currentValue: c.confidenceCalibration.expectedCalibrationError,
      delta: eceDelta,
      detectedAt,
    });
  }

  const winDelta = c.overall.target1HitRate - b.overall.target1HitRate;
  if (Math.abs(winDelta) >= 0.05) {
    alerts.push({
      category: 'performance_drift',
      severity: severity(winDelta, 0.08, 0.15),
      message: `Target-1 hit rate shifted by ${(winDelta * 100).toFixed(1)}pp`,
      baselineValue: b.overall.target1HitRate,
      currentValue: c.overall.target1HitRate,
      delta: winDelta,
      detectedAt,
    });
  }

  const bStrategies = new Map(b.strategyLeaderboard.map((s) => [s.key, s.winRate]));
  for (const row of c.strategyLeaderboard) {
    const prior = bStrategies.get(row.key);
    if (prior == null) continue;
    const delta = row.winRate - prior;
    if (Math.abs(delta) >= 0.1) {
      alerts.push({
        category: 'strategy_drift',
        severity: severity(delta, 0.12, 0.2),
        message: `Strategy ${row.key} win rate shifted by ${(delta * 100).toFixed(1)}pp`,
        baselineValue: prior,
        currentValue: row.winRate,
        delta,
        detectedAt,
      });
    }
  }

  const bFeatures = new Map(b.featureImportanceSummary.map((f) => [f.feature, f.averageFeatureScore]));
  for (const row of c.featureImportanceSummary) {
    const prior = bFeatures.get(row.feature);
    if (prior == null) continue;
    const delta = row.averageFeatureScore - prior;
    if (Math.abs(delta) >= 5) {
      alerts.push({
        category: 'feature_drift',
        severity: severity(delta, 8, 15),
        message: `Feature ${row.feature} outcome score shifted by ${delta.toFixed(1)}`,
        baselineValue: prior,
        currentValue: row.averageFeatureScore,
        delta,
        detectedAt,
      });
    }
  }

  const bRegimes = Object.entries(b.marketRegimeSummary);
  for (const [env, metrics] of Object.entries(c.marketRegimeSummary)) {
    const prior = bRegimes.find(([k]) => k === env)?.[1]?.[0];
    if (!prior) continue;
    const current = metrics[0];
    if (!current) continue;
    const delta = current.winRate - prior.winRate;
    if (Math.abs(delta) >= 0.08) {
      alerts.push({
        category: 'market_regime_drift',
        severity: severity(delta, 0.1, 0.18),
        message: `Regime ${env} win rate shifted by ${(delta * 100).toFixed(1)}pp`,
        baselineValue: prior.winRate,
        currentValue: current.winRate,
        delta,
        detectedAt,
      });
    }
  }

  // Phase 8 — entry-trigger / MFE-MAE / data-quality from snapshot overalls
  const bOverall = b.overall;
  const cOverall = c.overall;
  if (bOverall.sampleCount >= 20 && cOverall.sampleCount >= 20) {
    const trigDelta = cOverall.entryTriggeredRate - bOverall.entryTriggeredRate;
    if (Math.abs(trigDelta) >= 0.08) {
      alerts.push({
        category: 'entry_trigger_drift',
        severity: severity(trigDelta, 0.1, 0.18),
        message: `Entry trigger rate shifted by ${(trigDelta * 100).toFixed(1)}pp`,
        baselineValue: bOverall.entryTriggeredRate,
        currentValue: cOverall.entryTriggeredRate,
        delta: trigDelta,
        detectedAt,
      });
    }

    const mfeDelta = cOverall.avgMfePct - bOverall.avgMfePct;
    const maeDelta = cOverall.avgMaePct - bOverall.avgMaePct;
    if (Math.abs(mfeDelta) >= 0.4 || Math.abs(maeDelta) >= 0.4) {
      alerts.push({
        category: 'mfe_mae_drift',
        severity: severity(Math.max(Math.abs(mfeDelta), Math.abs(maeDelta)), 0.6, 1.2),
        message: `MFE Δ${mfeDelta.toFixed(2)}pp / MAE Δ${maeDelta.toFixed(2)}pp`,
        baselineValue: bOverall.avgMfePct,
        currentValue: cOverall.avgMfePct,
        delta: mfeDelta,
        detectedAt,
      });
    }

    // Proxy data-quality: non-trigger + expired share
    const qualityProxy = (o: typeof bOverall) => {
      const expiredShare = (o.exitReasons.expired ?? 0) / Math.max(1, o.sampleCount);
      return 1 - o.entryTriggeredRate + expiredShare;
    };
    const bQ = qualityProxy(bOverall);
    const cQ = qualityProxy(cOverall);
    const qualityDelta = cQ - bQ;
    if (Math.abs(qualityDelta) >= 0.05) {
      alerts.push({
        category: 'data_quality_drift',
        severity: severity(qualityDelta, 0.08, 0.15),
        message: `Data-quality proxy shifted by ${(qualityDelta * 100).toFixed(1)}pp`,
        baselineValue: bQ,
        currentValue: cQ,
        delta: qualityDelta,
        detectedAt,
      });
    }
  }

  // Phase 8 — alias calibration as precision/calibration drift for governance
  for (const a of [...alerts]) {
    if (a.category === 'confidence_drift') {
      alerts.push({ ...a, category: 'precision_drift', message: `Precision/ECE: ${a.message}` });
      alerts.push({ ...a, category: 'calibration_drift', message: `Calibration: ${a.message}` });
    }
    if (a.category === 'strategy_drift') {
      alerts.push({ ...a, category: 'strategy_mix_drift', message: `Strategy mix: ${a.message}` });
    }
    if (a.category === 'market_regime_drift') {
      alerts.push({ ...a, category: 'regime_distribution_drift', message: `Regime mix: ${a.message}` });
    }
  }

  return {
    baselineSnapshotId: baseline.snapshotId,
    currentSnapshotId: current.snapshotId,
    alerts,
    alertCount: alerts.length,
  };
}

/** Log drift alerts to audit trail — informational only. */
export function recordDriftAlerts(
  report: DriftDetectionReport,
  parameterId = 'drift-monitor',
): void {
  for (const alert of report.alerts) {
    void logAdaptiveAudit({
      parameterId,
      action: 'drift_alert',
      actor: 'driftDetection',
      reason: `[${alert.category}] ${alert.message}`,
      snapshotId: report.currentSnapshotId,
      metrics: alert as unknown as Record<string, unknown>,
    });
  }
}

/** Lightweight drift from outcome records (no snapshot required). */
export function detectPerformanceDriftFromRecords(
  baseline: readonly OutcomeAnalyticsRecord[],
  current: readonly OutcomeAnalyticsRecord[],
  detectedAt = new Date().toISOString(),
): DriftAlert[] {
  const winRate = (rows: readonly OutcomeAnalyticsRecord[]) =>
    rows.length === 0 ? 0 : rows.filter((r) => r.outcome.target1Hit).length / rows.length;
  const b = winRate(baseline);
  const c = winRate(current);
  const delta = c - b;
  if (Math.abs(delta) < 0.05) return [];
  return [{
    category: 'performance_drift',
    severity: severity(delta, 0.08, 0.15),
    message: `Rolling win rate shifted by ${(delta * 100).toFixed(1)}pp`,
    baselineValue: b,
    currentValue: c,
    delta,
    detectedAt,
  }];
}
