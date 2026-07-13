import { db } from '@/lib/db';
import type { AdaptiveParameterRecord } from './adaptiveParameterTypes';
import { verifyAdaptiveParameterRecord } from './adaptiveParameterStore';
import {
  saveAdaptiveParameterRecord,
  setActivePromotedParameter,
  getAdaptiveParameterRecord,
} from './adaptiveParameterStore';

let migrated = false;

export async function ensureAdaptiveParameterTables(): Promise<void> {
  if (migrated) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_adaptive_parameters (
      parameter_id VARCHAR(80) PRIMARY KEY,
      schema_version VARCHAR(20) NOT NULL,
      configuration_version VARCHAR(40) NOT NULL,
      learning_version VARCHAR(40) NOT NULL,
      effective_date DATETIME NOT NULL,
      expiry_date DATETIME NULL,
      source_snapshot_id VARCHAR(80) NOT NULL,
      training_window_days INT NOT NULL,
      sample_size INT NOT NULL,
      confidence_interval JSON NOT NULL,
      approval_status VARCHAR(20) NOT NULL,
      rollback_version VARCHAR(80) NULL,
      content_hash CHAR(64) NOT NULL,
      parameters_json JSON NOT NULL,
      validation_metrics JSON NULL,
      created_at DATETIME NOT NULL,
      promoted_at DATETIME NULL,
      generated_by VARCHAR(100) NOT NULL,
      reason TEXT NULL,
      UNIQUE KEY uniq_adaptive_content_hash (content_hash),
      INDEX idx_adaptive_status (approval_status),
      INDEX idx_adaptive_created (created_at)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_adaptive_parameter_audit (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      parameter_id VARCHAR(80) NOT NULL,
      action VARCHAR(30) NOT NULL,
      actor VARCHAR(100) NOT NULL,
      reason TEXT,
      snapshot_id VARCHAR(80) NULL,
      metrics_json JSON NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_adaptive_audit_param (parameter_id),
      INDEX idx_adaptive_audit_created (created_at)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_adaptive_parameter_pointer (
      pointer_name VARCHAR(40) PRIMARY KEY,
      parameter_id VARCHAR(80) NOT NULL,
      activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      activated_by VARCHAR(100)
    )
  `);
  migrated = true;
}

export async function persistAdaptiveParameter(record: AdaptiveParameterRecord): Promise<void> {
  if (!verifyAdaptiveParameterRecord(record)) {
    throw new Error('Refusing to persist invalid adaptive parameter record');
  }
  await ensureAdaptiveParameterTables();
  await db.query(
    `INSERT IGNORE INTO q365_adaptive_parameters
      (parameter_id, schema_version, configuration_version, learning_version,
       effective_date, expiry_date, source_snapshot_id, training_window_days,
       sample_size, confidence_interval, approval_status, rollback_version,
       content_hash, parameters_json, validation_metrics, created_at, promoted_at,
       generated_by, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.parameterId,
      record.schemaVersion,
      record.configurationVersion,
      record.learningVersion,
      record.effectiveDate.slice(0, 19).replace('T', ' '),
      record.expiryDate ? record.expiryDate.slice(0, 19).replace('T', ' ') : null,
      record.sourceSnapshotId,
      record.trainingWindowDays,
      record.sampleSize,
      JSON.stringify(record.confidenceInterval),
      record.approvalStatus,
      record.rollbackVersion,
      record.contentHash,
      JSON.stringify(record.parameters),
      record.validationMetrics ? JSON.stringify(record.validationMetrics) : null,
      record.createdAt.slice(0, 19).replace('T', ' '),
      record.promotedAt ? record.promotedAt.slice(0, 19).replace('T', ' ') : null,
      record.generatedBy,
      record.reason,
    ],
  );
  saveAdaptiveParameterRecord(record);
}

export async function updateAdaptiveParameterStatus(
  parameterId: string,
  patch: Partial<Pick<AdaptiveParameterRecord, 'approvalStatus' | 'validationMetrics' | 'promotedAt' | 'rollbackVersion' | 'reason'>>,
): Promise<void> {
  await ensureAdaptiveParameterTables();
  const existing = getAdaptiveParameterRecord(parameterId);
  if (!existing) throw new Error(`Adaptive parameter not found: ${parameterId}`);
  const merged = { ...existing, ...patch };
  saveAdaptiveParameterRecord(merged);
  await db.query(
    `UPDATE q365_adaptive_parameters
     SET approval_status = ?, validation_metrics = ?, promoted_at = ?, rollback_version = ?, reason = ?
     WHERE parameter_id = ?`,
    [
      merged.approvalStatus,
      merged.validationMetrics ? JSON.stringify(merged.validationMetrics) : null,
      merged.promotedAt ? merged.promotedAt.slice(0, 19).replace('T', ' ') : null,
      merged.rollbackVersion,
      merged.reason,
      parameterId,
    ],
  );
}

export async function activateAdaptiveParameterPointer(
  parameterId: string,
  actor: string,
): Promise<void> {
  await ensureAdaptiveParameterTables();
  await db.query(
    `INSERT INTO q365_adaptive_parameter_pointer
      (pointer_name, parameter_id, activated_at, activated_by)
     VALUES ('active', ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       parameter_id = VALUES(parameter_id),
       activated_at = VALUES(activated_at),
       activated_by = VALUES(activated_by)`,
    [parameterId, actor],
  );
  setActivePromotedParameter(parameterId);
}

export async function loadActiveAdaptiveParameterFromDb(): Promise<AdaptiveParameterRecord | null> {
  await ensureAdaptiveParameterTables();
  const { rows } = await db.query<{ parameter_id: string }>(
    `SELECT parameter_id FROM q365_adaptive_parameter_pointer WHERE pointer_name = 'active' LIMIT 1`,
  );
  if (rows.length === 0) return null;
  return loadAdaptiveParameterById(rows[0].parameter_id);
}

export async function loadAdaptiveParameterById(parameterId: string): Promise<AdaptiveParameterRecord | null> {
  await ensureAdaptiveParameterTables();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM q365_adaptive_parameters WHERE parameter_id = ? LIMIT 1`,
    [parameterId],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const record: AdaptiveParameterRecord = {
    parameterId: String(r.parameter_id),
    schemaVersion: String(r.schema_version),
    configurationVersion: String(r.configuration_version),
    learningVersion: String(r.learning_version),
    effectiveDate: String(r.effective_date),
    expiryDate: r.expiry_date ? String(r.expiry_date) : null,
    sourceSnapshotId: String(r.source_snapshot_id),
    trainingWindowDays: Number(r.training_window_days),
    sampleSize: Number(r.sample_size),
    confidenceInterval: typeof r.confidence_interval === 'string'
      ? JSON.parse(r.confidence_interval)
      : r.confidence_interval as AdaptiveParameterRecord['confidenceInterval'],
    approvalStatus: r.approval_status as AdaptiveParameterRecord['approvalStatus'],
    rollbackVersion: r.rollback_version ? String(r.rollback_version) : null,
    contentHash: String(r.content_hash),
    parameters: typeof r.parameters_json === 'string'
      ? JSON.parse(r.parameters_json)
      : r.parameters_json as AdaptiveParameterRecord['parameters'],
    validationMetrics: r.validation_metrics
      ? (typeof r.validation_metrics === 'string'
        ? JSON.parse(r.validation_metrics)
        : r.validation_metrics) as AdaptiveParameterRecord['validationMetrics']
      : null,
    createdAt: String(r.created_at),
    promotedAt: r.promoted_at ? String(r.promoted_at) : null,
    generatedBy: String(r.generated_by),
    reason: r.reason ? String(r.reason) : null,
  };
  saveAdaptiveParameterRecord(record);
  if (record.approvalStatus === 'promoted') setActivePromotedParameter(record.parameterId);
  return record;
}

export async function logAdaptiveParameterAuditDb(input: {
  parameterId: string;
  action: string;
  actor: string;
  reason: string;
  snapshotId?: string | null;
  metrics?: Record<string, unknown> | null;
}): Promise<void> {
  await ensureAdaptiveParameterTables();
  await db.query(
    `INSERT INTO q365_adaptive_parameter_audit
      (parameter_id, action, actor, reason, snapshot_id, metrics_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.parameterId,
      input.action,
      input.actor,
      input.reason,
      input.snapshotId ?? null,
      input.metrics ? JSON.stringify(input.metrics) : null,
    ],
  );
}
