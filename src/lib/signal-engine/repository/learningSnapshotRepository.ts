import { db } from '@/lib/db';
import type { ImmutableLearningSnapshot } from '../learning/versionedLearningSnapshots';
import { verifyLearningSnapshot } from '../learning/versionedLearningSnapshots';

let migrated = false;

export async function ensureLearningSnapshotTables(): Promise<void> {
  if (migrated) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_learning_snapshots (
      snapshot_id VARCHAR(80) PRIMARY KEY,
      schema_version VARCHAR(20) NOT NULL,
      configuration_version VARCHAR(40) NOT NULL,
      feature_version VARCHAR(40) NOT NULL,
      confidence_version VARCHAR(40) NOT NULL,
      learning_version VARCHAR(40) NOT NULL,
      benchmark_version VARCHAR(40) NOT NULL,
      outcome_version VARCHAR(40) NOT NULL,
      benchmark_metrics JSON NOT NULL,
      source_metadata JSON NOT NULL,
      content_hash CHAR(64) NOT NULL,
      created_at DATETIME NOT NULL,
      UNIQUE KEY uniq_learning_content_hash (content_hash),
      INDEX idx_learning_created_at (created_at)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_learning_snapshot_audit (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      snapshot_id VARCHAR(80) NOT NULL,
      action VARCHAR(30) NOT NULL,
      reason TEXT,
      actor VARCHAR(100),
      metadata_json JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_learning_audit_snapshot (snapshot_id),
      INDEX idx_learning_audit_created (created_at)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_learning_snapshot_pointer (
      pointer_name VARCHAR(40) PRIMARY KEY,
      snapshot_id VARCHAR(80) NOT NULL,
      activated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      activated_by VARCHAR(100)
    )
  `);
  migrated = true;
}

/** Immutable insert: existing snapshot IDs/content are never updated. */
export async function saveLearningSnapshot(snapshot: ImmutableLearningSnapshot): Promise<void> {
  if (!verifyLearningSnapshot(snapshot)) throw new Error('Refusing to persist invalid learning snapshot');
  await ensureLearningSnapshotTables();
  await db.query(
    `INSERT IGNORE INTO q365_learning_snapshots
      (snapshot_id, schema_version, configuration_version, feature_version,
       confidence_version, learning_version, benchmark_version, outcome_version,
       benchmark_metrics, source_metadata, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      snapshot.snapshotId,
      snapshot.schemaVersion,
      snapshot.versions.configurationVersion,
      snapshot.versions.featureVersion,
      snapshot.versions.confidenceVersion,
      snapshot.versions.learningVersion,
      snapshot.versions.benchmarkVersion,
      snapshot.versions.outcomeVersion,
      JSON.stringify(snapshot.benchmarkMetrics),
      JSON.stringify(snapshot.source),
      snapshot.contentHash,
      snapshot.createdAt.slice(0, 19).replace('T', ' '),
    ],
  );
  await logLearningSnapshotAudit(snapshot.snapshotId, 'created', 'Scheduled immutable snapshot');
}

export async function logLearningSnapshotAudit(
  snapshotId: string,
  action: 'created' | 'activated' | 'rolled_back' | 'replayed',
  reason: string,
  actor = 'learningScheduler',
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await ensureLearningSnapshotTables();
  await db.query(
    `INSERT INTO q365_learning_snapshot_audit
      (snapshot_id, action, reason, actor, metadata_json)
     VALUES (?, ?, ?, ?, ?)`,
    [snapshotId, action, reason, actor, JSON.stringify(metadata)],
  );
}

/**
 * Rollback changes only the active analytics pointer. Immutable snapshots
 * and signal-generation state are never modified.
 */
export async function loadLatestLearningSnapshot(): Promise<ImmutableLearningSnapshot | null> {
  await ensureLearningSnapshotTables();
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT snapshot_id, schema_version, configuration_version, feature_version,
            confidence_version, learning_version, benchmark_version, outcome_version,
            benchmark_metrics, source_metadata, content_hash, created_at
     FROM q365_learning_snapshots
     ORDER BY created_at DESC
     LIMIT 1`,
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const benchmarkMetrics = typeof r.benchmark_metrics === 'string'
    ? JSON.parse(r.benchmark_metrics)
    : r.benchmark_metrics;
  const source = typeof r.source_metadata === 'string'
    ? JSON.parse(r.source_metadata)
    : r.source_metadata;
  return {
    snapshotId: String(r.snapshot_id),
    schemaVersion: String(r.schema_version),
    createdAt: String(r.created_at),
    versions: {
      configurationVersion: String(r.configuration_version),
      featureVersion: String(r.feature_version),
      confidenceVersion: String(r.confidence_version),
      learningVersion: String(r.learning_version),
      benchmarkVersion: String(r.benchmark_version),
      outcomeVersion: String(r.outcome_version),
    },
    source,
    benchmarkMetrics,
    contentHash: String(r.content_hash),
  };
}
export async function activateLearningSnapshot(
  snapshotId: string,
  options: { actor?: string; reason: string; rollback?: boolean },
): Promise<void> {
  await ensureLearningSnapshotTables();
  const { rows } = await db.query<{ snapshot_id: string }>(
    `SELECT snapshot_id FROM q365_learning_snapshots WHERE snapshot_id = ?`,
    [snapshotId],
  );
  if (rows.length === 0) throw new Error(`Learning snapshot not found: ${snapshotId}`);
  await db.query(
    `INSERT INTO q365_learning_snapshot_pointer
      (pointer_name, snapshot_id, activated_at, activated_by)
     VALUES ('active', ?, NOW(), ?)
     ON DUPLICATE KEY UPDATE
       snapshot_id = VALUES(snapshot_id),
       activated_at = VALUES(activated_at),
       activated_by = VALUES(activated_by)`,
    [snapshotId, options.actor ?? 'operator'],
  );
  await logLearningSnapshotAudit(
    snapshotId,
    options.rollback ? 'rolled_back' : 'activated',
    options.reason,
    options.actor ?? 'operator',
  );
}
