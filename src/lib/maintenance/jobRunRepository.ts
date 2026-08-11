import { db } from '@/lib/db';
import type {
  JobRunStore, MaintenanceRunRecord, MaintenanceStageName, StageResult,
} from './types';

const VERSION = 'v1';

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * MySQL atomic claim. The unique stage/date/version key is the distributed
 * lock; stale running claims can be recovered after a worker crash.
 */
export const maintenanceJobRunStore: JobRunStore = {
  async claim({ runId, jobName, tradingDate, staleAfterMs }) {
    const staleSeconds = Math.max(60, Math.ceil(staleAfterMs / 1_000));
    await db.query(
      `INSERT INTO q365_maintenance_job_runs
         (run_id, job_name, trading_date, job_version, status, started_at, heartbeat_at)
       VALUES (?, ?, ?, ?, 'running', NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         run_id = IF(status IN ('failed','partial','pending') OR
                     (status='running' AND heartbeat_at < DATE_SUB(NOW(), INTERVAL ? SECOND)),
                     VALUES(run_id), run_id),
         retry_count = IF(status IN ('failed','partial') OR
                          (status='running' AND heartbeat_at < DATE_SUB(NOW(), INTERVAL ? SECOND)),
                          retry_count + 1, retry_count),
         status = IF(status IN ('failed','partial','pending') OR
                     (status='running' AND heartbeat_at < DATE_SUB(NOW(), INTERVAL ? SECOND)),
                     'running', status),
         started_at = IF(run_id=VALUES(run_id), NOW(), started_at),
         heartbeat_at = IF(run_id=VALUES(run_id), NOW(), heartbeat_at),
         completed_at = IF(run_id=VALUES(run_id), NULL, completed_at),
         last_error = IF(run_id=VALUES(run_id), NULL, last_error)`,
      [runId, jobName, tradingDate, VERSION, staleSeconds, staleSeconds, staleSeconds],
    );
    const { rows } = await db.query<any>(
      `SELECT run_id, status FROM q365_maintenance_job_runs
        WHERE job_name=? AND trading_date=? AND job_version=? LIMIT 1`,
      [jobName, tradingDate, VERSION],
    );
    if (rows[0]?.status === 'succeeded') return 'completed';
    return rows[0]?.run_id === runId && rows[0]?.status === 'running' ? 'claimed' : 'busy';
  },

  async finish({ runId, jobName, tradingDate, result, dependencyRunIds }) {
    await db.query(
      `UPDATE q365_maintenance_job_runs SET status=?, completed_at=NOW(), heartbeat_at=NOW(),
         expected_count=?, processed_count=?, success_count=?, failure_count=?, last_error=?,
         dependency_run_ids=?, metadata_json=?
       WHERE run_id=? AND job_name=? AND trading_date=? AND job_version=?`,
      [result.status, result.counts?.expected ?? null, result.counts?.processed ?? 0,
       result.counts?.succeeded ?? 0, result.counts?.failed ?? 0, result.reason ?? null,
       json(dependencyRunIds), json(result.metadata), runId, jobName, tradingDate, VERSION],
    );
  },

  async fail({ runId, jobName, tradingDate, error, retryCount, dependencyRunIds }) {
    await db.query(
      `UPDATE q365_maintenance_job_runs SET status='failed', completed_at=NOW(), heartbeat_at=NOW(),
         retry_count=?, last_error=?, dependency_run_ids=?
       WHERE run_id=? AND job_name=? AND trading_date=? AND job_version=?`,
      [retryCount, error.slice(0, 8_000), json(dependencyRunIds), runId, jobName, tradingDate, VERSION],
    );
  },

  async skip({ runId, jobName, tradingDate, reason, dependencyRunIds }) {
    // Insert is required when dependency failure means this stage was never claimed.
    await db.query(
      `INSERT INTO q365_maintenance_job_runs
         (run_id, job_name, trading_date, job_version, status, completed_at, last_error, dependency_run_ids)
       VALUES (?, ?, ?, ?, 'skipped', NOW(), ?, ?)
       ON DUPLICATE KEY UPDATE status=IF(status='succeeded', status, 'skipped'),
         completed_at=IF(status='succeeded', completed_at, NOW()),
         last_error=IF(status='succeeded', last_error, VALUES(last_error)),
         dependency_run_ids=VALUES(dependency_run_ids)`,
      [runId, jobName, tradingDate, VERSION, reason, json(dependencyRunIds)],
    );
  },

  async getForDate(tradingDate) {
    const { rows } = await db.query<any>(
      `SELECT run_id, job_name, trading_date, status, retry_count, completed_at, last_error
         FROM q365_maintenance_job_runs WHERE trading_date=? AND job_version=? ORDER BY id`,
      [tradingDate, VERSION],
    );
    return rows.map((row: any): MaintenanceRunRecord => ({
      runId: String(row.run_id), jobName: row.job_name as MaintenanceStageName,
      tradingDate: String(row.trading_date).slice(0, 10), status: row.status,
      retryCount: Number(row.retry_count ?? 0),
      completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
      lastError: row.last_error ?? null,
    }));
  },
};

export async function readMaintenanceHealth(limit = 24): Promise<MaintenanceRunRecord[]> {
  const { rows } = await db.query<any>(
    `SELECT run_id, job_name, trading_date, status, retry_count, completed_at, last_error
       FROM q365_maintenance_job_runs ORDER BY trading_date DESC, id DESC LIMIT ?`, [limit],
  );
  return rows.map((row: any) => ({
    runId: String(row.run_id), jobName: row.job_name,
    tradingDate: String(row.trading_date).slice(0, 10), status: row.status,
    retryCount: Number(row.retry_count ?? 0),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    lastError: row.last_error ?? null,
  }));
}
