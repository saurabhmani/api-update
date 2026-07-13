// ════════════════════════════════════════════════════════════════
//  Strategy Hub — configuration version history (Phase 3)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureStrategyHubTables } from './strategyHubSchema';
import type { StrategyConfigHistoryRow } from '../types';

function parseJsonField(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function recordConfigHistory(entry: {
  strategyId: string;
  userId: number;
  versionNumber: number;
  previousValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  changeSummary: string;
  reason?: string | null;
  actor?: string | null;
  source?: 'ui' | 'api' | 'restore' | 'reset';
}): Promise<void> {
  await ensureStrategyHubTables();
  await db.query(
    `INSERT INTO strategy_hub_config_history
       (strategy_id, user_id, version_number, previous_values_json, new_values_json,
        change_summary, reason, actor, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.strategyId,
      entry.userId,
      entry.versionNumber,
      entry.previousValues ? JSON.stringify(entry.previousValues) : null,
      entry.newValues ? JSON.stringify(entry.newValues) : null,
      entry.changeSummary,
      entry.reason ?? null,
      entry.actor ?? null,
      entry.source ?? 'ui',
    ],
  );
}

export async function listConfigHistory(opts: {
  strategyId: string;
  limit?: number;
}): Promise<StrategyConfigHistoryRow[]> {
  await ensureStrategyHubTables();
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
  const { rows } = await db.query(
    `SELECT id, strategy_id, user_id, version_number, previous_values_json,
            new_values_json, change_summary, reason, actor, source, created_at
       FROM strategy_hub_config_history
      WHERE strategy_id = ?
      ORDER BY version_number DESC, created_at DESC
      LIMIT ${limit}`,
    [opts.strategyId],
  );

  return (rows as Record<string, unknown>[]).map((r) => ({
    id:              Number(r.id),
    strategy_id:     String(r.strategy_id),
    user_id:         Number(r.user_id),
    version_number:  Number(r.version_number),
    previous_values_json: parseJsonField(r.previous_values_json),
    new_values_json:      parseJsonField(r.new_values_json),
    change_summary:  String(r.change_summary ?? ''),
    reason:          r.reason != null ? String(r.reason) : null,
    actor:           r.actor != null ? String(r.actor) : null,
    source:          String(r.source ?? 'ui') as StrategyConfigHistoryRow['source'],
    created_at:      String(r.created_at),
  }));
}

export async function loadConfigHistoryVersion(
  strategyId: string,
  versionId: number,
): Promise<StrategyConfigHistoryRow | null> {
  await ensureStrategyHubTables();
  const { rows } = await db.query(
    `SELECT id, strategy_id, user_id, version_number, previous_values_json,
            new_values_json, change_summary, reason, actor, source, created_at
       FROM strategy_hub_config_history
      WHERE strategy_id = ? AND id = ?
      LIMIT 1`,
    [strategyId, versionId],
  );
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id:              Number(r.id),
    strategy_id:     String(r.strategy_id),
    user_id:         Number(r.user_id),
    version_number:  Number(r.version_number),
    previous_values_json: parseJsonField(r.previous_values_json),
    new_values_json:      parseJsonField(r.new_values_json),
    change_summary:  String(r.change_summary ?? ''),
    reason:          r.reason != null ? String(r.reason) : null,
    actor:           r.actor != null ? String(r.actor) : null,
    source:          String(r.source ?? 'ui') as StrategyConfigHistoryRow['source'],
    created_at:      String(r.created_at),
  };
}

export async function getLatestConfigVersion(strategyId: string): Promise<number> {
  await ensureStrategyHubTables();
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(version_number), 0) AS v
       FROM strategy_hub_config_history
      WHERE strategy_id = ?`,
    [strategyId],
  );
  return Number((rows[0] as Record<string, unknown>)?.v ?? 0);
}
