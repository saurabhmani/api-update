// ════════════════════════════════════════════════════════════════
//  Strategy Hub — portfolio alerts (Phase 8)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { PortfolioAlert, PortfolioAlertSeverity, PortfolioAlertStatus, PortfolioAlertType } from '../portfolio/types';
import { ensureStrategyHubTables } from './strategyHubSchema';

function mapRow(r: Record<string, unknown>): PortfolioAlert {
  return {
    id: Number(r.id),
    alertKey: String(r.alert_key),
    type: String(r.alert_type) as PortfolioAlertType,
    severity: String(r.severity) as PortfolioAlertSeverity,
    title: String(r.title),
    description: String(r.description),
    suggestedAction: String(r.suggested_action ?? ''),
    status: String(r.status) as PortfolioAlertStatus,
    strategyId: r.strategy_id ? String(r.strategy_id) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
    acknowledgedAt: r.acknowledged_at ? new Date(String(r.acknowledged_at)).toISOString() : null,
    acknowledgedBy: r.acknowledged_by ? String(r.acknowledged_by) : null,
    resolvedAt: r.resolved_at ? new Date(String(r.resolved_at)).toISOString() : null,
    resolvedBy: r.resolved_by ? String(r.resolved_by) : null,
  };
}

export async function upsertPortfolioAlert(entry: {
  alertKey: string;
  type: PortfolioAlertType;
  severity: PortfolioAlertSeverity;
  strategyId?: string | null;
  title: string;
  description: string;
  suggestedAction: string;
}): Promise<number> {
  await ensureStrategyHubTables();
  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM strategy_hub_portfolio_alerts
      WHERE alert_key = ? AND status IN ('open', 'acknowledged')
      ORDER BY created_at DESC LIMIT 1`,
    [entry.alertKey],
  );
  if (rows?.[0]?.id) return rows[0].id;

  const { insertId } = await db.query(
    `INSERT INTO strategy_hub_portfolio_alerts
       (alert_key, alert_type, severity, strategy_id, title, description, suggested_action, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
    [
      entry.alertKey,
      entry.type,
      entry.severity,
      entry.strategyId ?? null,
      entry.title,
      entry.description,
      entry.suggestedAction,
    ],
  );
  return Number(insertId ?? 0);
}

export async function listPortfolioAlerts(opts: {
  status?: PortfolioAlertStatus | 'all';
  limit?: number;
}): Promise<PortfolioAlert[]> {
  await ensureStrategyHubTables();
  const limit = Math.min(opts.limit ?? 50, 200);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.status && opts.status !== 'all') {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM strategy_hub_portfolio_alerts ${where} ORDER BY created_at DESC LIMIT ${limit}`,
    params,
  );
  return (rows ?? []).map(mapRow);
}

export async function updatePortfolioAlertStatus(
  id: number,
  status: PortfolioAlertStatus,
  actor: string,
): Promise<boolean> {
  await ensureStrategyHubTables();
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const fields: string[] = ['status = ?'];
  const params: unknown[] = [status];
  if (status === 'acknowledged') {
    fields.push('acknowledged_at = ?', 'acknowledged_by = ?');
    params.push(now, actor);
  }
  if (status === 'resolved') {
    fields.push('resolved_at = ?', 'resolved_by = ?');
    params.push(now, actor);
  }
  params.push(id);
  const { affectedRows } = await db.query(
    `UPDATE strategy_hub_portfolio_alerts SET ${fields.join(', ')} WHERE id = ?`,
    params,
  );
  return Number(affectedRows ?? 0) > 0;
}

export async function countOpenPortfolioAlerts(): Promise<number> {
  await ensureStrategyHubTables();
  try {
    const { rows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM strategy_hub_portfolio_alerts WHERE status = 'open'`,
    );
    return Number(rows?.[0]?.c ?? 0);
  } catch {
    return 0;
  }
}
