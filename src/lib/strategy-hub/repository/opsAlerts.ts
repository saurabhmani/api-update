import { db } from '@/lib/db';
import { ensureStrategyHubTables } from './strategyHubSchema';
import type { AlertSeverity, AlertStatus, StrategyAlert } from '../operations/types';

function rowToAlert(r: Record<string, unknown>): StrategyAlert {
  return {
    id: Number(r.id),
    alertKey: String(r.alert_key),
    severity: r.severity as AlertSeverity,
    strategyId: r.strategy_id ? String(r.strategy_id) : null,
    strategyName: null,
    title: String(r.title),
    description: String(r.description),
    suggestedAction: String(r.suggested_action ?? ''),
    status: r.status as AlertStatus,
    createdAt: new Date(String(r.created_at)).toISOString(),
    acknowledgedAt: r.acknowledged_at ? new Date(String(r.acknowledged_at)).toISOString() : null,
    acknowledgedBy: r.acknowledged_by ? String(r.acknowledged_by) : null,
    resolvedAt: r.resolved_at ? new Date(String(r.resolved_at)).toISOString() : null,
    resolvedBy: r.resolved_by ? String(r.resolved_by) : null,
  };
}

export async function upsertAlert(entry: {
  alertKey: string;
  severity: AlertSeverity;
  strategyId?: string | null;
  title: string;
  description: string;
  suggestedAction: string;
}): Promise<number> {
  await ensureStrategyHubTables();
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM strategy_hub_alerts
      WHERE alert_key = ? AND status IN ('open', 'acknowledged')
      ORDER BY created_at DESC LIMIT 1`,
    [entry.alertKey],
  );
  if (rows?.[0]?.id) return rows[0].id;

  const { insertId } = await db.query(
    `INSERT INTO strategy_hub_alerts
       (alert_key, severity, strategy_id, title, description, suggested_action, status)
     VALUES (?, ?, ?, ?, ?, ?, 'open')`,
    [
      entry.alertKey,
      entry.severity,
      entry.strategyId ?? null,
      entry.title,
      entry.description,
      entry.suggestedAction,
    ],
  );
  return Number(insertId ?? 0);
}

export async function listAlerts(opts: {
  status?: AlertStatus | 'all';
  strategyId?: string;
  limit?: number;
}): Promise<StrategyAlert[]> {
  await ensureStrategyHubTables();
  const limit = Math.min(opts.limit ?? 50, 200);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.status && opts.status !== 'all') {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  if (opts.strategyId) {
    clauses.push('strategy_id = ?');
    params.push(opts.strategyId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM strategy_hub_alerts ${where} ORDER BY created_at DESC LIMIT ${limit}`,
    params,
  );
  return (rows ?? []).map(rowToAlert);
}

export async function updateAlertStatus(
  alertId: number,
  status: AlertStatus,
  actor: string,
): Promise<boolean> {
  await ensureStrategyHubTables();
  const field = status === 'acknowledged' ? 'acknowledged' : 'resolved';
  const { affectedRows } = await db.query(
    `UPDATE strategy_hub_alerts
        SET status = ?,
            ${field}_at = NOW(),
            ${field}_by = ?
      WHERE id = ? AND status != 'resolved'`,
    [status, actor, alertId],
  );
  return Number(affectedRows ?? 0) > 0;
}

export async function countOpenAlerts(): Promise<number> {
  await ensureStrategyHubTables();
  try {
    const { rows } = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM strategy_hub_alerts WHERE status IN ('open', 'acknowledged')`,
    );
    return Number(rows?.[0]?.cnt ?? 0);
  } catch {
    return 0;
  }
}
