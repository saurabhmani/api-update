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

/** Phase 2.5 — auditable calibration modifier change. */
export interface CalibrationAuditEntry {
  bucket: string;
  strategyName: string | null;
  regime: string | null;
  volatilityState: string | null;
  oldModifier: number;
  newModifier: number;
  proposedModifier: number;
  sampleSize: number;
  actualPrecision: number;
  evidenceJson: Record<string, unknown>;
  /** scheduled_learning | manual | replay */
  approverState: 'pending' | 'auto_applied' | 'rejected' | 'replay';
  modelVersion: string;
  cycleId?: string | null;
}

// ── Save confidence calibration snapshot ───────────────────
export async function saveConfidenceCalibration(
  snap: ConfidenceCalibrationSnapshot,
  strategyName: string | null = null,
  regime: string | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO q365_confidence_calibration
      (bucket, strategy_name, regime, volatility_state, sample_size, target1_hit_rate,
       avg_mfe, avg_mae, calibration_state, suggested_modifier, evidence_weight,
       wilson_lower, wilson_upper, brier_score, ece, entry_trigger_rate, expiry_rate,
       model_version, evidence_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      snap.bucket,
      strategyName ?? snap.strategyName ?? null,
      regime ?? snap.regime ?? null,
      snap.volatilityState ?? null,
      snap.sampleSize,
      snap.target1HitRate,
      snap.avgMFE,
      snap.avgMAE ?? null,
      snap.calibrationState,
      snap.suggestedModifier ?? 0,
      snap.evidenceWeight ?? 0,
      snap.wilsonLower ?? null,
      snap.wilsonUpper ?? null,
      snap.brierScore ?? null,
      snap.expectedCalibrationError ?? null,
      snap.entryTriggerRate ?? null,
      snap.expiryRate ?? null,
      snap.modelVersion ?? null,
      JSON.stringify({
        priorHitRate: snap.priorHitRate ?? null,
      }),
    ],
  );
}

/** Append-only audit so a calibration update can be fully replayed. */
export async function saveCalibrationAudit(entry: CalibrationAuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO q365_confidence_calibration_audit
      (bucket, strategy_name, regime, volatility_state,
       old_modifier, new_modifier, proposed_modifier, sample_size, actual_precision,
       evidence_json, approver_state, model_version, cycle_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      entry.bucket,
      entry.strategyName,
      entry.regime,
      entry.volatilityState,
      entry.oldModifier,
      entry.newModifier,
      entry.proposedModifier,
      entry.sampleSize,
      entry.actualPrecision,
      JSON.stringify(entry.evidenceJson),
      entry.approverState,
      entry.modelVersion,
      entry.cycleId ?? null,
    ],
  );
}

/** Latest applied modifiers keyed for cycle-bound deltas. */
export async function loadLatestCalibrationModifiers(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const { rows } = await db.query(
      `SELECT bucket, strategy_name, regime, volatility_state, new_modifier
         FROM q365_confidence_calibration_audit
        WHERE id IN (
          SELECT MAX(id) FROM q365_confidence_calibration_audit
           WHERE approver_state IN ('auto_applied', 'replay')
           GROUP BY bucket, strategy_name, regime, volatility_state
        )`,
    );
    for (const r of rows as Array<Record<string, unknown>>) {
      const key = [
        String(r.bucket ?? ''),
        r.strategy_name == null ? '' : String(r.strategy_name),
        r.regime == null ? '' : String(r.regime),
        r.volatility_state == null ? '' : String(r.volatility_state),
      ].join('|');
      map.set(key, Number(r.new_modifier ?? 0));
    }
  } catch {
    // Table may not exist yet on first boot — treat as empty history.
  }
  return map;
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
  // Audit log is append-only — never cleared for replayability.
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

  // Phase 2 — extend confidence calibration + audit (idempotent ALTERs)
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_confidence_calibration_audit (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      bucket VARCHAR(20) NOT NULL,
      strategy_name VARCHAR(60) DEFAULT NULL,
      regime VARCHAR(40) DEFAULT NULL,
      volatility_state VARCHAR(40) DEFAULT NULL,
      old_modifier INT NOT NULL DEFAULT 0,
      new_modifier INT NOT NULL DEFAULT 0,
      proposed_modifier INT NOT NULL DEFAULT 0,
      sample_size INT NOT NULL DEFAULT 0,
      actual_precision DECIMAL(8,4) NOT NULL DEFAULT 0,
      evidence_json JSON,
      approver_state VARCHAR(20) NOT NULL DEFAULT 'auto_applied',
      model_version VARCHAR(20) DEFAULT NULL,
      cycle_id VARCHAR(64) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_cca_bucket (bucket),
      INDEX idx_cca_created (created_at),
      INDEX idx_cca_cycle (cycle_id)
    )
  `);

  const alterCols: Array<[string, string]> = [
    ['volatility_state', 'VARCHAR(40) DEFAULT NULL'],
    ['avg_mae', 'DECIMAL(8,4) DEFAULT NULL'],
    ['suggested_modifier', 'INT NOT NULL DEFAULT 0'],
    ['evidence_weight', 'DECIMAL(6,4) NOT NULL DEFAULT 0'],
    ['wilson_lower', 'DECIMAL(8,4) DEFAULT NULL'],
    ['wilson_upper', 'DECIMAL(8,4) DEFAULT NULL'],
    ['brier_score', 'DECIMAL(8,4) DEFAULT NULL'],
    ['ece', 'DECIMAL(8,4) DEFAULT NULL'],
    ['entry_trigger_rate', 'DECIMAL(8,4) DEFAULT NULL'],
    ['expiry_rate', 'DECIMAL(8,4) DEFAULT NULL'],
    ['model_version', 'VARCHAR(20) DEFAULT NULL'],
    ['evidence_json', 'JSON'],
  ];
  for (const [col, def] of alterCols) {
    try {
      await db.query(`ALTER TABLE q365_confidence_calibration ADD COLUMN ${col} ${def}`);
    } catch {
      // column already exists
    }
  }

  _learningMigrated = true;
}
