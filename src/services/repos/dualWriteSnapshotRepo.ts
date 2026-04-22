// ════════════════════════════════════════════════════════════════
//  dualWriteSnapshotRepo — transitional write fan-out
//
//  PURPOSE:
//    During the MySQL → PostgreSQL migration, every snapshot write
//    should land in BOTH stores so we can validate consistency and
//    cut over without a data gap. After a clean validation window
//    (see PHASE2_CONSOLIDATION.md), the MySQL branch is deleted
//    and this file becomes a thin wrapper around snapshotRepo.
//
//  WRITE SEMANTICS:
//    • Postgres write is authoritative — the error propagates.
//    • MySQL write is best-effort — logged on failure but NOT
//      thrown. This is intentional: once the system is PG-first,
//      a MySQL hiccup must not fail the operation.
//    • No write to MySQL if MYSQL_DUAL_WRITE_TABLE is unset. The
//      exact table name is deployment-specific (your schema has no
//      single canonical snapshots table today) — the operator sets
//      it once they've picked the target.
//
//  ORDER:
//    PG first, then MySQL. If PG fails, nothing was written; if
//    MySQL fails, PG has the truth. Reversing this would mean a
//    MySQL success + PG failure leaves MySQL "ahead" with no audit
//    trail, which is the opposite of what we want while PG is the
//    target.
// ════════════════════════════════════════════════════════════════

import {
  upsertSnapshot,
  upsertSnapshotBatch,
  type UpsertSnapshotInput,
} from './snapshotRepo';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'dualWriteSnapshotRepo' });

const MYSQL_TABLE = process.env.MYSQL_DUAL_WRITE_TABLE?.trim() || null;

interface MySqlAdapter {
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; affectedRows?: number }>;
}

// Lazy-loaded so this module doesn't force-import MySQL when
// dual-write is disabled.
let mysqlCached: MySqlAdapter | null = null;
async function getMysql(): Promise<MySqlAdapter | null> {
  if (!MYSQL_TABLE) return null;
  if (mysqlCached) return mysqlCached;
  try {
    const mod = await import('@/lib/db');
    mysqlCached = mod.db as unknown as MySqlAdapter;
    return mysqlCached;
  } catch (err) {
    log.warn('dual-write: mysql module unavailable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Shape the MySQL UPSERT defensively. Column names map to the most
 *  likely layout (symbol + price + ts). If your target table uses
 *  different column names, override by setting MYSQL_DUAL_WRITE_SQL
 *  to a full ON-DUPLICATE-KEY statement that references :cols.
 *
 *  ⚠ The shim in src/lib/db.ts already rewrites ON CONFLICT to MySQL
 *  syntax, so we write standard Postgres here and let the shim
 *  translate when running against MySQL. */
function buildDefaultMysqlUpsert(table: string): string {
  return `
    INSERT INTO \`${table}\`
      (symbol, price, prev_close, \`change\`, change_percent,
       open, high, low, volume, source, data_quality, fetched_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(? / 1000), NOW())
    ON DUPLICATE KEY UPDATE
      price          = VALUES(price),
      prev_close     = VALUES(prev_close),
      \`change\`     = VALUES(\`change\`),
      change_percent = VALUES(change_percent),
      open           = VALUES(open),
      high           = VALUES(high),
      low            = VALUES(low),
      volume         = VALUES(volume),
      source         = VALUES(source),
      data_quality   = VALUES(data_quality),
      fetched_at     = VALUES(fetched_at),
      updated_at     = NOW()
  `;
}

// ── Public write surface ────────────────────────────────────────────

export async function writeSnapshot(input: UpsertSnapshotInput): Promise<void> {
  // 1. Postgres (authoritative)
  await upsertSnapshot(input);

  // 2. MySQL (best-effort, only when configured)
  const mysql = await getMysql();
  if (!mysql || !MYSQL_TABLE) return;
  try {
    const sql = process.env.MYSQL_DUAL_WRITE_SQL?.trim() || buildDefaultMysqlUpsert(MYSQL_TABLE);
    await mysql.query(sql, [
      input.symbol,
      input.price,
      input.prevClose,
      input.change,
      input.changePercent,
      input.open,
      input.high,
      input.low,
      input.volume,
      input.source,
      input.dataQuality,
      input.timestamp,
    ]);
  } catch (err) {
    log.warn('dual-write: mysql upsert failed (non-fatal)', {
      table: MYSQL_TABLE,
      symbol: input.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function writeSnapshotBatch(inputs: UpsertSnapshotInput[]): Promise<number> {
  if (inputs.length === 0) return 0;
  // Postgres batch first (one round-trip via UNNEST).
  const written = await upsertSnapshotBatch(inputs);

  const mysql = await getMysql();
  if (!mysql || !MYSQL_TABLE) return written;

  // MySQL has no UNNEST — iterate. Parallelism capped low to avoid
  // hammering an ageing MySQL during the migration window.
  const CONCURRENCY = 4;
  const queue = [...inputs];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const item = queue.shift();
        if (!item) return;
        try {
          const sql = process.env.MYSQL_DUAL_WRITE_SQL?.trim() || buildDefaultMysqlUpsert(MYSQL_TABLE);
          await mysql.query(sql, [
            item.symbol, item.price, item.prevClose, item.change, item.changePercent,
            item.open, item.high, item.low, item.volume,
            item.source, item.dataQuality, item.timestamp,
          ]);
        } catch (err) {
          log.warn('dual-write batch: mysql row failed', {
            symbol: item.symbol,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }),
  );
  return written;
}

export function dualWriteEnabled(): boolean {
  return !!MYSQL_TABLE;
}
