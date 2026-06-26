// Admin Monitoring — canonical acceptance tables (MySQL runtime DDL)

import { db } from '@/lib/db';

let migrated = false;

/** MySQL DATETIME columns reject ISO-8601 (`2026-06-26T17:13:03.000Z`). */
function toMysqlDateTime(input: string | Date | null | undefined): string | null {
  if (input == null || input === '') return null;
  const iso = input instanceof Date ? input.toISOString() : String(input);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(iso)) return iso;
  return iso.slice(0, 19).replace('T', ' ');
}

export async function ensureAdminMonitoringTables(): Promise<void> {
  if (migrated) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS cron_job_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        job_name VARCHAR(128) NOT NULL,
        job_label VARCHAR(255),
        status VARCHAR(24) NOT NULL,
        duration_ms INT,
        error_message TEXT,
        metadata_json JSON,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at DATETIME,
        INDEX idx_cron_job_logs_time (started_at),
        INDEX idx_cron_job_logs_name (job_name, started_at),
        INDEX idx_cron_job_logs_status (status, started_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS api_health_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        route VARCHAR(255),
        status VARCHAR(24) NOT NULL,
        error_rate DECIMAL(8,4),
        avg_latency_ms INT,
        uptime_pct DECIMAL(6,2),
        quota_state VARCHAR(32),
        details_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_api_health_logs_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS system_health_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        overall_status VARCHAR(24) NOT NULL,
        metrics_json JSON NOT NULL,
        data_delay_sec INT,
        cron_failures INT DEFAULT 0,
        strategy_failures INT DEFAULT 0,
        alert_count INT DEFAULT 0,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_system_health_logs_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS admin_actions (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        actor_id INT,
        actor_email VARCHAR(255),
        action VARCHAR(128) NOT NULL,
        resource VARCHAR(128),
        detail_json JSON,
        ip_address VARCHAR(64),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_admin_actions_time (created_at),
        INDEX idx_admin_actions_action (action, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS system_alerts (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        alert_key VARCHAR(128) NOT NULL,
        severity VARCHAR(16) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        source VARCHAR(64) NOT NULL DEFAULT 'admin_monitor',
        status VARCHAR(24) NOT NULL DEFAULT 'active',
        context_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME,
        INDEX idx_system_alerts_time (created_at),
        INDEX idx_system_alerts_status (status, severity, created_at),
        UNIQUE KEY uq_system_alerts_key_active (alert_key, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    migrated = true;
  } catch {
    // Non-fatal
  }
}

export async function logCronJob(input: {
  jobName: string;
  jobLabel?: string;
  status: string;
  durationMs?: number;
  errorMessage?: string;
  metadata?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
}): Promise<void> {
  await ensureAdminMonitoringTables();
  await db.query(
    `INSERT INTO cron_job_logs (job_name, job_label, status, duration_ms, error_message, metadata_json, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.jobName,
      input.jobLabel ?? null,
      input.status,
      input.durationMs ?? null,
      input.errorMessage ?? null,
      input.metadata ? JSON.stringify(input.metadata) : null,
      toMysqlDateTime(input.startedAt ?? new Date()),
      toMysqlDateTime(input.finishedAt),
    ],
  );
}

export async function logApiHealth(input: {
  route?: string;
  status: string;
  errorRate?: number;
  avgLatencyMs?: number;
  uptimePct?: number;
  quotaState?: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  await ensureAdminMonitoringTables();
  await db.query(
    `INSERT INTO api_health_logs (route, status, error_rate, avg_latency_ms, uptime_pct, quota_state, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.route ?? null,
      input.status,
      input.errorRate ?? null,
      input.avgLatencyMs ?? null,
      input.uptimePct ?? null,
      input.quotaState ?? null,
      input.details ? JSON.stringify(input.details) : null,
    ],
  );
}

export async function logSystemHealth(input: {
  overallStatus: string;
  metrics: Record<string, unknown>;
  dataDelaySec?: number | null;
  cronFailures?: number;
  strategyFailures?: number;
  alertCount?: number;
}): Promise<void> {
  await ensureAdminMonitoringTables();
  await db.query(
    `INSERT INTO system_health_logs
       (overall_status, metrics_json, data_delay_sec, cron_failures, strategy_failures, alert_count)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.overallStatus,
      JSON.stringify(input.metrics),
      input.dataDelaySec ?? null,
      input.cronFailures ?? 0,
      input.strategyFailures ?? 0,
      input.alertCount ?? 0,
    ],
  );
}

export async function logAdminAction(input: {
  actorId?: number;
  actorEmail?: string;
  action: string;
  resource?: string;
  detail?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  await ensureAdminMonitoringTables();
  await db.query(
    `INSERT INTO admin_actions (actor_id, actor_email, action, resource, detail_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.actorId ?? null,
      input.actorEmail ?? null,
      input.action,
      input.resource ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
      input.ipAddress ?? null,
    ],
  );
}

export async function upsertAlert(input: {
  alertKey: string;
  severity: string;
  title: string;
  message: string;
  source?: string;
  context?: Record<string, unknown>;
}): Promise<void> {
  await ensureAdminMonitoringTables();
  await db.query(
    `INSERT INTO system_alerts (alert_key, severity, title, message, source, context_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       severity = VALUES(severity),
       title = VALUES(title),
       message = VALUES(message),
       context_json = VALUES(context_json),
       created_at = CURRENT_TIMESTAMP`,
    [
      input.alertKey,
      input.severity,
      input.title,
      input.message,
      input.source ?? 'admin_monitor',
      input.context ? JSON.stringify(input.context) : null,
    ],
  );
}

export async function resolveAlertsExcept(activeKeys: string[]): Promise<void> {
  await ensureAdminMonitoringTables();
  if (activeKeys.length === 0) {
    await db.query(
      `UPDATE system_alerts SET status = 'resolved', resolved_at = NOW() WHERE status = 'active'`,
    );
    return;
  }
  const placeholders = activeKeys.map(() => '?').join(', ');
  await db.query(
    `UPDATE system_alerts SET status = 'resolved', resolved_at = NOW()
      WHERE status = 'active' AND alert_key NOT IN (${placeholders})`,
    activeKeys,
  );
}

export async function listCronJobLogs(opts?: { failedOnly?: boolean; limit?: number }) {
  await ensureAdminMonitoringTables();
  const limit = opts?.limit ?? 100;
  const where = opts?.failedOnly ? `WHERE status = 'failed'` : '';
  try {
    const { rows } = await db.query(
      `SELECT id, job_name, job_label, status, duration_ms, error_message, metadata_json, started_at, finished_at
         FROM cron_job_logs ${where}
        ORDER BY started_at DESC LIMIT ?`,
      [limit],
    );
    return (rows as any[]).map(mapCronRow);
  } catch {
    return [];
  }
}

export async function listApiHealthLogs(limit = 50) {
  await ensureAdminMonitoringTables();
  try {
    const { rows } = await db.query(
      `SELECT id, route, status, error_rate, avg_latency_ms, uptime_pct, quota_state, details_json, created_at
         FROM api_health_logs ORDER BY created_at DESC LIMIT ?`,
      [limit],
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      route: r.route,
      status: r.status,
      errorRate: r.error_rate != null ? Number(r.error_rate) : null,
      avgLatencyMs: r.avg_latency_ms,
      uptimePct: r.uptime_pct != null ? Number(r.uptime_pct) : null,
      quotaState: r.quota_state,
      details: parseJson(r.details_json),
      createdAt: new Date(r.created_at).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function listSystemHealthLogs(limit = 50) {
  await ensureAdminMonitoringTables();
  try {
    const { rows } = await db.query(
      `SELECT id, overall_status, metrics_json, data_delay_sec, cron_failures, strategy_failures, alert_count, created_at
         FROM system_health_logs ORDER BY created_at DESC LIMIT ?`,
      [limit],
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      overallStatus: r.overall_status,
      metrics: parseJson(r.metrics_json),
      dataDelaySec: r.data_delay_sec,
      cronFailures: Number(r.cron_failures ?? 0),
      strategyFailures: Number(r.strategy_failures ?? 0),
      alertCount: Number(r.alert_count ?? 0),
      createdAt: new Date(r.created_at).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function listAdminActions(limit = 100) {
  await ensureAdminMonitoringTables();
  try {
    const { rows } = await db.query(
      `SELECT id, actor_id, actor_email, action, resource, detail_json, ip_address, created_at
         FROM admin_actions ORDER BY created_at DESC LIMIT ?`,
      [limit],
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      actorId: r.actor_id,
      actorEmail: r.actor_email,
      action: r.action,
      resource: r.resource,
      detail: parseJson(r.detail_json),
      ipAddress: r.ip_address,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function listActiveAlerts(limit = 100) {
  await ensureAdminMonitoringTables();
  try {
    const { rows } = await db.query(
      `SELECT id, alert_key, severity, title, message, source, status, context_json, created_at, resolved_at
         FROM system_alerts WHERE status = 'active'
        ORDER BY FIELD(severity, 'critical', 'warning', 'info'), created_at DESC
        LIMIT ?`,
      [limit],
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      alertKey: r.alert_key,
      severity: r.severity,
      title: r.title,
      message: r.message,
      source: r.source,
      status: r.status,
      context: parseJson(r.context_json),
      createdAt: new Date(r.created_at).toISOString(),
      resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

export async function syncCronLogsFromSources(
  jobs: Array<{
    id: string;
    label: string;
    lastRunAt: string | null;
    lastStatus: string;
    lastDurationMs: number | null;
    failureCount24h: number;
  }>,
): Promise<void> {
  for (const j of jobs) {
    if (!j.lastRunAt) continue;
    await logCronJob({
      jobName: j.id,
      jobLabel: j.label,
      status: j.lastStatus === 'unknown' ? 'running' : j.lastStatus,
      durationMs: j.lastDurationMs ?? undefined,
      metadata: { failureCount24h: j.failureCount24h },
      startedAt: j.lastRunAt,
    });
  }
}

function mapCronRow(r: any) {
  return {
    id: Number(r.id),
    jobName: r.job_name,
    jobLabel: r.job_label,
    status: r.status,
    durationMs: r.duration_ms,
    errorMessage: r.error_message,
    metadata: parseJson(r.metadata_json),
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
  };
}

function parseJson(val: unknown): Record<string, unknown> {
  if (!val) return {};
  if (typeof val === 'object') return val as Record<string, unknown>;
  try { return JSON.parse(String(val)); } catch { return {}; }
}
