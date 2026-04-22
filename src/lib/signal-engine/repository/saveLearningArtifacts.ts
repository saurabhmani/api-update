// ════════════════════════════════════════════════════════════════
//  Learning Scheduler — Persistence Helpers
//
//  The Phase 4 feedback helpers (aggregatePerformance, calibrateConfidence,
//  computeAdaptiveRecommendation) are pure — they compute snapshots but
//  don't write anywhere. This module owns the writes, plus the migration
//  for adaptive-recommendation + job-run tables that don't live in
//  savePhase4Artifacts.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type {
  ConfidenceCalibrationSnapshot,
  StrategyPerformanceSnapshot,
  AdaptiveRecommendation,
} from '../types/phase4.types';

// ── Save confidence calibration snapshot ───────────────────
export async function saveConfidenceCalibration(
  snap: ConfidenceCalibrationSnapshot,
  strategyName: string | null = null,
  regime: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO q365_confidence_calibration
      (bucket, strategy_name, regime, sample_size, target1_hit_rate,
       avg_mfe, calibration_state, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      snap.bucket,
      strategyName,
      regime,
      snap.sampleSize,
      snap.target1HitRate,
      snap.avgMFE,
      snap.calibrationState,
    ],
  );
}

// ── Save strategy performance snapshot ─────────────────────
export async function saveStrategyPerformance(
  snap: StrategyPerformanceSnapshot,
): Promise<void> {
  await db.query(
    `INSERT INTO q365_strategy_performance_snapshots
      (strategy_name, regime, volatility_state, sector, sample_size,
       win_rate, target1_hit_rate, avg_pnl_r, avg_mfe, avg_mae, environment_fit, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      snap.strategyName,
      snap.regime,
      snap.volatilityState,
      snap.sector,
      snap.sampleSize,
      snap.winRate,
      snap.target1HitRate,
      snap.avgPnlR,
      snap.avgMFE,
      snap.avgMAE,
      snap.environmentFit,
    ],
  );
}

// ── Save adaptive recommendation ───────────────────────────
export async function saveAdaptiveRecommendation(
  rec: AdaptiveRecommendation,
  strategyName: string,
  regime: string,
  volatilityState: string | null,
  sector: string | null,
): Promise<void> {
  await db.query(
    `INSERT INTO q365_adaptive_recommendations
      (strategy_name, regime, volatility_state, sector,
       environment_fit, recommended_modifier, reason,
       sample_size, evidence_strength, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      strategyName,
      regime,
      volatilityState,
      sector,
      rec.strategyEnvironmentFit,
      rec.recommendedConfidenceModifier,
      rec.reason,
      rec.sampleSize,
      rec.evidenceStrength,
    ],
  );
}

// ── Delete same-day rows (idempotency helper) ──────────────
// Running the scheduler twice on the same day should replace the day's
// snapshots rather than accumulate duplicates. We key on DATE(computed_at)
// so intra-day retries are safe.
export async function clearTodaysLearningSnapshots(): Promise<void> {
  await db.query(
    `DELETE FROM q365_confidence_calibration WHERE DATE(computed_at) = CURDATE()`,
  );
  await db.query(
    `DELETE FROM q365_strategy_performance_snapshots WHERE DATE(computed_at) = CURDATE()`,
  );
  await db.query(
    `DELETE FROM q365_adaptive_recommendations WHERE DATE(computed_at) = CURDATE()`,
  );
}

// ── Job run logging ────────────────────────────────────────
export interface LearningJobRunInput {
  jobName: string;
  status: 'success' | 'failed' | 'skipped';
  durationMs: number;
  counts: Record<string, number>;
  errorMsg?: string | null;
}

export async function logLearningJobRun(input: LearningJobRunInput): Promise<void> {
  await db.query(
    `INSERT INTO q365_learning_job_runs
      (job_name, status, duration_ms, counts_json, error_msg, run_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [
      input.jobName,
      input.status,
      input.durationMs,
      JSON.stringify(input.counts),
      input.errorMsg ?? null,
    ],
  );
}

// ── Idempotent migration (called by scheduler entrypoint) ──
let _learningMigrated = false;
export async function ensureLearningTables(): Promise<void> {
  if (_learningMigrated) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_adaptive_recommendations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      strategy_name VARCHAR(50) NOT NULL,
      regime VARCHAR(30) NOT NULL,
      volatility_state VARCHAR(30),
      sector VARCHAR(50),
      environment_fit VARCHAR(30) NOT NULL,
      recommended_modifier INT NOT NULL DEFAULT 0,
      reason TEXT,
      sample_size INT NOT NULL DEFAULT 0,
      evidence_strength VARCHAR(20) NOT NULL,
      computed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_adaptive_strategy (strategy_name),
      INDEX idx_adaptive_regime (regime),
      INDEX idx_adaptive_computed (computed_at)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_learning_job_runs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      job_name VARCHAR(60) NOT NULL,
      status VARCHAR(20) NOT NULL,
      duration_ms INT NOT NULL DEFAULT 0,
      counts_json JSON,
      error_msg TEXT,
      run_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ljr_job (job_name),
      INDEX idx_ljr_run_at (run_at)
    )
  `);

  _learningMigrated = true;
}
