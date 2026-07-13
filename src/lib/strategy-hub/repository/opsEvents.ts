import { db } from '@/lib/db';
import { ensureStrategyHubTables } from './strategyHubSchema';

export async function recordOpsEvent(entry: {
  eventType: string;
  strategyId?: string | null;
  severity?: string;
  title: string;
  description?: string;
  actor?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  await ensureStrategyHubTables();
  await db.query(
    `INSERT INTO strategy_hub_ops_events
       (event_type, strategy_id, severity, title, description, actor, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.eventType,
      entry.strategyId ?? null,
      entry.severity ?? 'info',
      entry.title,
      entry.description ?? null,
      entry.actor ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    ],
  );
}

export async function listOpsEvents(opts: {
  strategyId?: string;
  eventType?: string;
  limit?: number;
}): Promise<Array<{
  id: number;
  eventType: string;
  strategyId: string | null;
  severity: string;
  title: string;
  description: string | null;
  actor: string | null;
  createdAt: string;
}>> {
  await ensureStrategyHubTables();
  const limit = Math.min(opts.limit ?? 50, 200);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.strategyId) {
    clauses.push('strategy_id = ?');
    params.push(opts.strategyId);
  }
  if (opts.eventType) {
    clauses.push('event_type = ?');
    params.push(opts.eventType);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM strategy_hub_ops_events ${where} ORDER BY created_at DESC LIMIT ${limit}`,
    params,
  );
  return (rows ?? []).map((r) => ({
    id: Number(r.id),
    eventType: String(r.event_type),
    strategyId: r.strategy_id ? String(r.strategy_id) : null,
    severity: String(r.severity),
    title: String(r.title),
    description: r.description ? String(r.description) : null,
    actor: r.actor ? String(r.actor) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
  }));
}
