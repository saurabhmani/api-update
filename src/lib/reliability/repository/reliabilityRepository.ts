// Platform Reliability — MySQL persistence + optional Postgres ops tables

import { db } from '@/lib/db';
import { pg } from '@/lib/db/postgres';
import type {
  AlertChannel,
  AlertDeliveryRecord,
  DeliveryStatus,
  ReliabilityAuditEntry,
  ReliabilityStatus,
} from '../types';

let migrated = false;

export async function ensureReliabilityTables(): Promise<void> {
  if (migrated) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS reliability_health_snapshots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        overall_status VARCHAR(16) NOT NULL,
        metrics_json JSON NOT NULL,
        alerts_json JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_rel_health_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS reliability_alert_deliveries (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        alert_id VARCHAR(64) NOT NULL,
        channel VARCHAR(16) NOT NULL,
        severity VARCHAR(16) NOT NULL,
        title VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL,
        error_message TEXT,
        payload_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_rel_alert_del_time (created_at),
        INDEX idx_rel_alert_del_alert (alert_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS reliability_audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        actor_id INT,
        actor_email VARCHAR(255),
        action VARCHAR(128) NOT NULL,
        resource VARCHAR(128),
        detail_json JSON NOT NULL,
        ip_address VARCHAR(64),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_rel_audit_time (created_at),
        INDEX idx_rel_audit_action (action, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    migrated = true;
  } catch {
    // Non-fatal — dashboard still works from live probes
  }
}

export async function saveHealthSnapshot(
  overallStatus: ReliabilityStatus,
  metrics: Record<string, unknown>,
  alerts: unknown[],
): Promise<void> {
  await ensureReliabilityTables();
  await db.query(
    `INSERT INTO reliability_health_snapshots (overall_status, metrics_json, alerts_json)
     VALUES (?, ?, ?)`,
    [overallStatus, JSON.stringify(metrics), JSON.stringify(alerts)],
  );
}

export async function recordAlertDelivery(input: {
  alertId: string;
  channel: AlertChannel;
  severity: string;
  title: string;
  status: DeliveryStatus;
  errorMessage?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await ensureReliabilityTables();
  await db.query(
    `INSERT INTO reliability_alert_deliveries
       (alert_id, channel, severity, title, status, error_message, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.alertId,
      input.channel,
      input.severity,
      input.title,
      input.status,
      input.errorMessage ?? null,
      input.payload ? JSON.stringify(input.payload) : null,
    ],
  );
}

export async function listAlertDeliveries(limit = 50): Promise<AlertDeliveryRecord[]> {
  await ensureReliabilityTables();
  try {
    const { rows } = await db.query(
      `SELECT id, alert_id, channel, severity, title, status, error_message, created_at
         FROM reliability_alert_deliveries
        ORDER BY created_at DESC
        LIMIT ?`,
      [limit],
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      alertId: r.alert_id,
      channel: r.channel,
      severity: r.severity,
      title: r.title,
      status: r.status,
      errorMessage: r.error_message,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function writeReliabilityAudit(input: {
  actorId?: number | null;
  actorEmail?: string | null;
  action: string;
  resource?: string | null;
  detail?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  await ensureReliabilityTables();
  await db.query(
    `INSERT INTO reliability_audit_logs (actor_id, actor_email, action, resource, detail_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.actorId ?? null,
      input.actorEmail ?? null,
      input.action,
      input.resource ?? null,
      JSON.stringify(input.detail ?? {}),
      input.ipAddress ?? null,
    ],
  );
}

export async function listReliabilityAudit(limit = 100): Promise<ReliabilityAuditEntry[]> {
  await ensureReliabilityTables();
  try {
    const { rows } = await db.query(
      `SELECT id, actor_id, actor_email, action, resource, detail_json, ip_address, created_at
         FROM reliability_audit_logs
        ORDER BY created_at DESC
        LIMIT ?`,
      [limit],
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      actorId: r.actor_id != null ? Number(r.actor_id) : null,
      actorEmail: r.actor_email,
      action: r.action,
      resource: r.resource,
      detail: typeof r.detail_json === 'string' ? JSON.parse(r.detail_json) : (r.detail_json ?? {}),
      ipAddress: r.ip_address,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  } catch {
    return [];
  }
}

interface JobRunRow {
  job_name: string;
  status: string;
  duration_ms: number | null;
  run_at: Date | string;
}

export async function fetchLearningJobRuns(days = 7): Promise<JobRunRow[]> {
  try {
    const { rows } = await db.query(
      `SELECT job_name, status, duration_ms, run_at
         FROM q365_learning_job_runs
        WHERE run_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        ORDER BY run_at DESC
        LIMIT 200`,
      [days],
    );
    return rows as JobRunRow[];
  } catch {
    return [];
  }
}

export async function fetchSyncLogs(days = 7): Promise<JobRunRow[]> {
  try {
    const { rows } = await db.query(
      `SELECT job_type AS job_name,
              CASE WHEN status = 'success' THEN 'success' ELSE 'failed' END AS status,
              duration_ms, created_at AS run_at
         FROM instrument_sync_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
        ORDER BY created_at DESC
        LIMIT 200`,
      [days],
    );
    return rows as JobRunRow[];
  } catch {
    return [];
  }
}

export async function fetchSchedulerRuns(limit = 50): Promise<Array<{
  label: string;
  started_at: string;
  finished_at: string | null;
  succeeded_count: number;
  failed_count: number;
  elapsed_ms: number | null;
}>> {
  try {
    const { rows } = await pg.query(
      `SELECT label, started_at, finished_at, succeeded_count, failed_count, elapsed_ms
         FROM ops.scheduler_runs
        ORDER BY started_at DESC
        LIMIT $1`,
      [limit],
    );
    return (rows as any[]).map((r) => ({
      label: r.label,
      started_at: new Date(r.started_at).toISOString(),
      finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      succeeded_count: Number(r.succeeded_count ?? 0),
      failed_count: Number(r.failed_count ?? 0),
      elapsed_ms: r.elapsed_ms != null ? Number(r.elapsed_ms) : null,
    }));
  } catch {
    return [];
  }
}

export async function fetchProviderHealthLogs(hours = 24): Promise<Array<{
  provider: string;
  event: string;
  created_at: string;
  latency_ms: number | null;
}>> {
  try {
    const { rows } = await pg.query(
      `SELECT provider, event, created_at, latency_ms
         FROM ops.provider_health_logs
        WHERE created_at >= NOW() - INTERVAL '${Math.min(hours, 168)} hours'
        ORDER BY created_at DESC
        LIMIT 100`,
    );
    return (rows as any[]).map((r) => ({
      provider: r.provider,
      event: r.event,
      created_at: new Date(r.created_at).toISOString(),
      latency_ms: r.latency_ms != null ? Number(r.latency_ms) : null,
    }));
  } catch {
    return [];
  }
}

export async function fetchBrokerPlatformStats(): Promise<Array<{
  broker: string;
  status: string;
  checked_at: string;
  latency_ms: number | null;
}>> {
  try {
    const { rows } = await db.query(
      `SELECT b.broker, b.status, b.checked_at, b.latency_ms
         FROM broker_health_snapshots b
         INNER JOIN (
           SELECT broker, MAX(checked_at) AS max_at
             FROM broker_health_snapshots
            GROUP BY broker
         ) latest ON b.broker = latest.broker AND b.checked_at = latest.max_at`,
    );
    return (rows as any[]).map((r) => ({
      broker: r.broker,
      status: r.status,
      checked_at: new Date(r.checked_at).toISOString(),
      latency_ms: r.latency_ms != null ? Number(r.latency_ms) : null,
    }));
  } catch {
    return [];
  }
}

export async function countBrokerFailures24h(): Promise<number> {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS c FROM broker_error_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
    );
    return Number((rows[0] as any)?.c ?? 0);
  } catch {
    return 0;
  }
}

export async function fetchUserSummary(): Promise<{
  totalUsers: number;
  activeUsers: number;
  adminUsers: number;
  disabledUsers: number;
  recentLogins24h: number;
}> {
  try {
    const { rows } = await db.query(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN role = 'admin' THEN 1 ELSE 0 END) AS admins,
         SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) AS disabled,
         SUM(CASE WHEN last_login_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 ELSE 0 END) AS recent_logins
       FROM users`,
    );
    const r = rows[0] as any;
    return {
      totalUsers: Number(r?.total ?? 0),
      activeUsers: Number(r?.active ?? 0),
      adminUsers: Number(r?.admins ?? 0),
      disabledUsers: Number(r?.disabled ?? 0),
      recentLogins24h: Number(r?.recent_logins ?? 0),
    };
  } catch {
    return { totalUsers: 0, activeUsers: 0, adminUsers: 0, disabledUsers: 0, recentLogins24h: 0 };
  }
}

export async function notifyAdminsSystem(title: string, message: string, severity: string): Promise<number> {
  try {
    const { rows } = await db.query(`SELECT id FROM users WHERE role = 'admin' AND is_active = 1`);
    const fullMessage = `[${severity.toUpperCase()}] ${title}: ${message}`;
    let count = 0;
    for (const row of rows as Array<{ id: number }>) {
      await db.query(
        `INSERT INTO notifications (user_id, type, message, is_read)
         VALUES (?, 'system', ?, 0)`,
        [row.id, fullMessage],
      );
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}
