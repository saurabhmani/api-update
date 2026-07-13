// ════════════════════════════════════════════════════════════════
//  Strategy Hub — mode change audit repository (Phase 2)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { StrategyMode } from '@/lib/signal-engine/types/signalEngine.types';
import { ensureStrategyHubTables } from './strategyHubSchema';
import type { StrategyModeHistoryRow, StrategyModeChangeSource } from '../types';

function parseJsonField(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function recordModeHistory(entry: {
  strategyId: string;
  userId: number;
  fromMode: StrategyMode | string | null;
  toMode: StrategyMode | string;
  reason?: string | null;
  source?: StrategyModeChangeSource;
  actor?: string | null;
  details?: Record<string, unknown> | null;
}): Promise<void> {
  await ensureStrategyHubTables();
  await db.query(
    `INSERT INTO strategy_hub_mode_history
       (strategy_id, user_id, from_mode, to_mode, reason, source, actor, details_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.strategyId,
      entry.userId,
      entry.fromMode,
      entry.toMode,
      entry.reason ?? null,
      entry.source ?? 'ui',
      entry.actor ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    ],
  );
}

export async function listModeHistory(opts: {
  strategyId?: string;
  limit?: number;
}): Promise<StrategyModeHistoryRow[]> {
  await ensureStrategyHubTables();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.strategyId) {
    clauses.push('strategy_id = ?');
    params.push(opts.strategyId);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query(
    `SELECT id, strategy_id, user_id, from_mode, to_mode, reason, source, actor,
            details_json, created_at
       FROM strategy_hub_mode_history
       ${where}
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    params,
  );

  return (rows as Record<string, unknown>[]).map((r) => ({
    id:           Number(r.id),
    strategy_id:  String(r.strategy_id),
    user_id:      Number(r.user_id),
    from_mode:    r.from_mode != null ? String(r.from_mode) : null,
    to_mode:      String(r.to_mode),
    reason:       r.reason != null ? String(r.reason) : null,
    source:       String(r.source ?? 'ui') as StrategyModeChangeSource,
    actor:        r.actor != null ? String(r.actor) : null,
    details_json: parseJsonField(r.details_json),
    created_at:   String(r.created_at),
  }));
}
