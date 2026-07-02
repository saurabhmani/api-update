// ════════════════════════════════════════════════════════════════
//  Universe snapshot + rebuild audit persistence
//
//  Tables: universe_snapshots, universe_snapshot_symbols, universe_rebuild_logs
//  Gracefully no-ops when tables are not yet migrated (testing-safe).
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { ChurnSelectionResult, ChurnSymbolDecision } from './nseUniverseChurn';

let snapshotTablesReady: boolean | null = null;

const SNAPSHOT_PROBE_SQL = 'SELECT 1 FROM universe_snapshots LIMIT 1';

export async function probeUniverseSnapshotTables(): Promise<boolean> {
  if (snapshotTablesReady !== null) return snapshotTablesReady;
  try {
    await db.query(SNAPSHOT_PROBE_SQL);
    snapshotTablesReady = true;
  } catch {
    snapshotTablesReady = false;
  }
  return snapshotTablesReady;
}

export function resetUniverseSnapshotTableProbe(): void {
  snapshotTablesReady = null;
}

export interface UniverseRebuildLogStart {
  triggerSource: string;
  dryRun: boolean;
  targetSize: number;
}

export interface UniverseRebuildLogComplete {
  ok: boolean;
  snapshotId: number | null;
  blockers: string[];
  summary: Record<string, unknown>;
  durationMs: number;
}

export async function startUniverseRebuildLog(
  input: UniverseRebuildLogStart,
): Promise<number | null> {
  if (!(await probeUniverseSnapshotTables())) {
    console.warn(
      '[UNIVERSE_AUDIT] universe_rebuild_logs not available — run migration or ensureAllSchemas',
    );
    return null;
  }
  try {
    const result = await db.query(
      `INSERT INTO universe_rebuild_logs
        (started_at, trigger_source, dry_run, ok, target_size)
       VALUES (UTC_TIMESTAMP(), ?, ?, 0, ?)`,
      [input.triggerSource, input.dryRun ? 1 : 0, input.targetSize],
    );
    return Number(result.insertId) || null;
  } catch (err) {
    console.warn('[UNIVERSE_AUDIT] startUniverseRebuildLog failed', err);
    snapshotTablesReady = false;
    return null;
  }
}

export async function completeUniverseRebuildLog(
  logId: number | null,
  input: UniverseRebuildLogComplete,
): Promise<void> {
  if (logId == null || !(await probeUniverseSnapshotTables())) return;
  try {
    await db.query(
      `UPDATE universe_rebuild_logs
          SET completed_at = UTC_TIMESTAMP(),
              ok = ?,
              snapshot_id = ?,
              blockers_json = ?,
              summary_json = ?,
              duration_ms = ?
        WHERE id = ?`,
      [
        input.ok ? 1 : 0,
        input.snapshotId,
        JSON.stringify(input.blockers),
        JSON.stringify(input.summary),
        input.durationMs,
        logId,
      ],
    );
  } catch (err) {
    console.warn('[UNIVERSE_AUDIT] completeUniverseRebuildLog failed', err);
  }
}

export interface PersistUniverseSnapshotInput {
  triggerSource: string;
  dryRun: boolean;
  ok: boolean;
  targetSize: number;
  churn: ChurnSelectionResult;
  summary: Record<string, unknown>;
  rebuildLogId?: number | null;
}

export async function persistUniverseSnapshot(
  input: PersistUniverseSnapshotInput,
): Promise<number | null> {
  if (!(await probeUniverseSnapshotTables())) {
    console.warn(
      '[UNIVERSE_AUDIT] snapshot tables not available — rebuild continues without audit persist',
    );
    return null;
  }

  const activeCount = input.churn.selected.length;
  try {
    const snapResult = await db.query(
      `INSERT INTO universe_snapshots
        (snapshot_at, trigger_source, target_size, active_count,
         added_count, removed_count, kept_count, dry_run, ok, summary_json)
       VALUES (UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.triggerSource,
        input.targetSize,
        activeCount,
        input.churn.added,
        input.churn.removed,
        input.churn.kept,
        input.dryRun ? 1 : 0,
        input.ok ? 1 : 0,
        JSON.stringify(input.summary),
      ],
    );
    const snapshotId = Number(snapResult.insertId);
    if (!snapshotId) return null;

    for (const d of input.churn.decisions) {
      await insertSnapshotSymbol(snapshotId, d, input.churn.selected.includes(d.symbol));
    }

    // Symbols selected via top-up may not appear in decisions for inactive adds only — ensure all selected logged
    const logged = new Set(input.churn.decisions.map((d) => d.symbol));
    for (const sym of input.churn.selected) {
      if (logged.has(sym)) continue;
      await insertSnapshotSymbol(snapshotId, {
        symbol: sym,
        rank: null,
        action: 'add',
        dataQualityOk: true,
        reason: 'selected',
        compositeScore: 0,
      }, true);
    }

    if (input.rebuildLogId != null) {
      await db.query(
        `UPDATE universe_rebuild_logs SET snapshot_id = ? WHERE id = ?`,
        [snapshotId, input.rebuildLogId],
      );
    }

    console.log(
      `[UNIVERSE_AUDIT] snapshot_id=${snapshotId} active=${activeCount} ` +
      `added=${input.churn.added} kept=${input.churn.kept} removed=${input.churn.removed}`,
    );
    return snapshotId;
  } catch (err) {
    console.warn('[UNIVERSE_AUDIT] persistUniverseSnapshot failed', err);
    snapshotTablesReady = false;
    return null;
  }
}

async function insertSnapshotSymbol(
  snapshotId: number,
  d: ChurnSymbolDecision,
  isActive: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO universe_snapshot_symbols
      (snapshot_id, symbol, rank_position, composite_score, action,
       data_quality_ok, is_active, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       rank_position = VALUES(rank_position),
       composite_score = VALUES(composite_score),
       action = VALUES(action),
       data_quality_ok = VALUES(data_quality_ok),
       is_active = VALUES(is_active),
       reason = VALUES(reason)`,
    [
      snapshotId,
      d.symbol,
      d.rank,
      d.compositeScore,
      d.action,
      d.dataQualityOk ? 1 : 0,
      isActive ? 1 : 0,
      d.reason.slice(0, 255),
    ],
  );
}

export const UNIVERSE_AUDIT_SQL = {
  latestSnapshot:
    'SELECT * FROM universe_snapshots ORDER BY snapshot_at DESC LIMIT 5;',
  latestRebuild:
    'SELECT * FROM universe_rebuild_logs ORDER BY started_at DESC LIMIT 5;',
  churnSummary:
    `SELECT action, COUNT(*) AS cnt FROM universe_snapshot_symbols
     WHERE snapshot_id = (SELECT MAX(id) FROM universe_snapshots)
     GROUP BY action;`,
};
