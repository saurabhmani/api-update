/**
 * scripts/addPerfIndexes.ts
 *
 *  Adds the indexes the production app needs to keep /api/signals
 *  responsive under load. Designed to be safely re-runnable: each
 *  CREATE INDEX checks INFORMATION_SCHEMA first and skips if the
 *  index already exists (MySQL pre-8.0.29 doesn't support
 *  CREATE INDEX IF NOT EXISTS on regular indexes).
 *
 *  Symptoms this fixes:
 *    [API/signals] getActiveSignals exceeded 10000ms — using fallback
 *    [API/signals] getDevelopingSetupBackfill exceeded 5000ms — using fallback
 *    [API/signals] candle freshness probe exceeded 3000ms — using fallback
 *    [API/signals] batch freshness probe exceeded 5000ms — using fallback
 *
 *  All four come from full table scans on q365_signals (the dashboard's
 *  main read source) and market_data_daily (the candle freshness probe).
 *  With proper indexes these queries drop from seconds to milliseconds.
 *
 *  How to run on the VPS:
 *    cd /var/www/api-update
 *    npm run db:perf-indexes
 *    pm2 restart quantorus365
 *
 *  Estimated runtime: ~30s per million rows in q365_signals (one-shot,
 *  online — does not lock the table for reads).
 */

// Load env from .env.local first (matches server.js + the rest of the
// codebase). Plain `dotenv/config` only reads `.env`, which this repo
// doesn't use — that's the source of the
//   "MySQL connection not configured" error this script first surfaced.
import * as path from 'node:path';
import * as dotenv from 'dotenv';
dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local'),
});

import { db } from '../src/lib/db';

interface IndexSpec {
  table:   string;
  name:    string;
  columns: string;
  reason:  string;
}

const INDEXES: IndexSpec[] = [
  // ── q365_signals ─────────────────────────────────────────────
  {
    table:   'q365_signals',
    name:    'idx_qs_status_decay',
    columns: 'status, decay_state, generated_at',
    reason:  'getActiveSignals WHERE status IN (...) AND decay_state <> ... ORDER BY generated_at',
  },
  {
    table:   'q365_signals',
    name:    'idx_qs_final_opp',
    columns: 'final_score DESC, opportunity_score DESC, generated_at DESC',
    reason:  'ORDER BY in getActiveSignals + ROW_NUMBER() partition',
  },
  {
    table:   'q365_signals',
    name:    'idx_qs_dir_score',
    columns: 'direction, final_score DESC, generated_at DESC',
    reason:  'PARTITION BY direction ORDER BY final_score in getActiveSignals window function',
  },
  {
    table:   'q365_signals',
    name:    'idx_qs_batch_gen',
    columns: 'batch_id, generated_at',
    reason:  'batch freshness probe: latest batch_id by generated_at',
  },
  {
    table:   'q365_signals',
    name:    'idx_qs_inst_gen',
    columns: 'instrument_key, generated_at',
    reason:  'rankings JOIN: latest signal per instrument_key',
  },
  {
    table:   'q365_signals',
    name:    'idx_qs_signal_status',
    columns: 'signal_status, generated_at',
    reason:  'WHERE signal_status = APPROVED_SIGNAL filter',
  },
  // Specific to getDevelopingSetupBackfill — its ORDER BY is
  // (confidence_score DESC, opportunity_score DESC, generated_at DESC)
  // which none of the existing indexes covered. Without this the query
  // does a full 65k-row scan + filesort and times out at 5s.
  {
    table:   'q365_signals',
    name:    'idx_qs_conf_opp',
    columns: 'confidence_score DESC, opportunity_score DESC, generated_at DESC',
    reason:  'getDevelopingSetupBackfill ORDER BY (the 5000ms timeout source)',
  },
  // Helps the OR predicate in getDevelopingSetupBackfill by giving
  // the optimizer a path on `invalidation_reason` lookups.
  {
    table:   'q365_signals',
    name:    'idx_qs_inv_reason',
    columns: 'invalidation_reason, generated_at',
    reason:  'getDevelopingSetupBackfill OR invalidation_reason IS NOT NULL',
  },
  // ── market_data_daily ────────────────────────────────────────
  {
    table:   'market_data_daily',
    name:    'idx_mdd_ts',
    columns: 'ts',
    reason:  'candle freshness probe: SELECT MAX(ts) FROM market_data_daily',
  },
  {
    table:   'market_data_daily',
    name:    'idx_mdd_sym_ts',
    columns: 'symbol, ts DESC',
    reason:  'per-symbol latest candle lookups in the signal engine',
  },
  // ── q365_manipulation_snapshots ──────────────────────────────
  // Even though the table has a UNIQUE KEY on (symbol, snapshot_date),
  // the LEFT JOIN in getActiveSignals uses COLLATE conversion which
  // defeats the index. Adding a non-collated lookup helper.
  {
    table:   'q365_manipulation_snapshots',
    name:    'idx_qms_sym_date',
    columns: 'symbol, snapshot_date DESC',
    reason:  'LEFT JOIN in getActiveSignals (latest snapshot per symbol)',
  },
];

interface ColumnCollation {
  table:    string;
  column:   string;
  collation: string;
}

async function getColumnCollation(table: string, column: string): Promise<string | null> {
  try {
    const { rows } = await db.query<ColumnCollation>(
      `SELECT COLLATION_NAME AS collation
         FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = ?
          AND COLUMN_NAME  = ?`,
      [table, column],
    );
    const r = rows[0] as any;
    return r?.collation ?? null;
  } catch {
    return null;
  }
}

async function indexExists(table: string, name: string): Promise<boolean> {
  try {
    const { rows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME   = ?
          AND INDEX_NAME   = ?`,
      [table, name],
    );
    return Number((rows[0] as any)?.c ?? 0) > 0;
  } catch {
    return false;
  }
}

async function tableExists(table: string): Promise<boolean> {
  const { rows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [table],
  );
  return Number((rows[0] as any)?.c ?? 0) > 0;
}

async function tableRowCount(table: string): Promise<number> {
  try {
    const { rows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM \`${table}\``,
    );
    return Number((rows[0] as any)?.c ?? 0);
  } catch {
    return -1;
  }
}

function bar(): void {
  console.log('─'.repeat(64));
}

async function main(): Promise<void> {
  bar();
  console.log('Performance indexes — applying to current database');
  bar();

  // Confirm DB target.
  try {
    const { rows } = await db.query<{ db: string }>(`SELECT DATABASE() AS db`);
    console.log(`Connected to: ${(rows[0] as any)?.db ?? '(unknown)'}`);
  } catch { /* non-fatal */ }
  bar();

  // ── Collation drift report ──────────────────────────────────
  // The getActiveSignals query JOINs with COLLATE conversion, which
  // defeats indexes. Report any column collation mismatches so the
  // operator can fix them with ALTER TABLE if needed (collation
  // changes lock the table, so we don't run them automatically).
  console.log('Checking column collations on join keys…');
  const cols = [
    { table: 'q365_signals',                column: 'symbol' },
    { table: 'q365_signals',                column: 'instrument_key' },
    { table: 'q365_manipulation_snapshots', column: 'symbol' },
    { table: 'q365_manipulation_penalties', column: 'signal_id' },
  ];
  const collations = new Map<string, string>();
  for (const { table, column } of cols) {
    if (!(await tableExists(table))) continue;
    const c = await getColumnCollation(table, column);
    if (c) collations.set(`${table}.${column}`, c);
  }
  for (const [k, v] of collations) console.log(`  ${k.padEnd(45)} → ${v}`);
  const distinct = new Set(collations.values());
  if (distinct.size > 1) {
    console.warn(`  ⚠ Mixed collations detected: ${[...distinct].join(', ')}`);
    console.warn('    The COLLATE casts in getActiveSignals were added to bridge this');
    console.warn('    drift. Indexes alone won\'t fully save you here — fix later with:');
    console.warn(`      ALTER TABLE q365_signals MODIFY symbol VARCHAR(50)`);
    console.warn(`        CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
  } else if (distinct.size === 1) {
    console.log(`  ✓ Consistent collation: ${[...distinct][0]}`);
  }
  bar();

  // ── Add indexes ─────────────────────────────────────────────
  let created = 0;
  let skipped = 0;
  let failed  = 0;

  for (const idx of INDEXES) {
    if (!(await tableExists(idx.table))) {
      console.log(`SKIP   ${idx.table.padEnd(32)} ${idx.name}  (table does not exist)`);
      skipped++;
      continue;
    }
    if (await indexExists(idx.table, idx.name)) {
      console.log(`EXISTS ${idx.table.padEnd(32)} ${idx.name}`);
      skipped++;
      continue;
    }
    const rows = await tableRowCount(idx.table);
    const t0 = Date.now();
    try {
      await db.query(
        `CREATE INDEX \`${idx.name}\` ON \`${idx.table}\` (${idx.columns})`,
      );
      const ms = Date.now() - t0;
      console.log(
        `CREATED ${idx.table.padEnd(32)} ${idx.name}  ` +
        `rows=${rows >= 0 ? rows : '?'}  elapsed=${ms}ms`,
      );
      console.log(`        reason: ${idx.reason}`);
      created++;
    } catch (err) {
      const msg = (err as any)?.message ?? String(err);
      console.error(`FAILED ${idx.table.padEnd(32)} ${idx.name}: ${msg}`);
      failed++;
    }
  }

  bar();
  console.log(`Done. created=${created}  existed=${skipped}  failed=${failed}`);
  console.log('Restart the app: pm2 restart quantorus365');
  bar();
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
  });
