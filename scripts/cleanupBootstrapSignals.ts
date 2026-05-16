/**
 * scripts/cleanupBootstrapSignals.ts — purge stale bootstrap rows and
 * deduplicate q365_signals before re-running the bootstrap.
 *
 * Usage:
 *   npx tsx scripts/cleanupBootstrapSignals.ts
 *   npx tsx scripts/cleanupBootstrapSignals.ts --dry-run    # report counts, no DELETE
 *   npx tsx scripts/cleanupBootstrapSignals.ts --keep-bootstrap   # only dedupe, don't drop bootstrap rows
 *
 * Two-step cleanup:
 *
 *   Step 1: DELETE every row written by the previous-version bootstrap
 *           script. The new bootstrap (post SIGNAL_ENGINE_FIXED_AND_CLEAN)
 *           uses a different scoring shape; mixing old and new rows in
 *           the dashboard produces the "duplicate symbols / blank
 *           fields / RR=1.5 across the board" symptoms the user
 *           reported. We identify old rows by `generation_source`.
 *
 *   Step 2: Dedupe across whatever remains — keep ONLY the latest row
 *           per (symbol, direction) pair. Anything with a smaller `id`
 *           than the most recent same-(symbol, direction) row gets
 *           dropped. This is the safety net against scanner runs that
 *           accidentally re-emitted a symbol without expiring the prior.
 *
 * Both steps are idempotent — safe to re-run.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });

import { db } from '@/lib/db';

interface CliArgs {
  dryRun:        boolean;
  keepBootstrap: boolean;
}

// ── Schema migration helpers (DB-FIX §1) ─────────────────────────

interface ColumnInfo { exists: boolean; nullable: boolean; type: string }

async function inspectColumn(table: string, column: string): Promise<ColumnInfo> {
  const { rows } = await db.query<{
    IS_NULLABLE: string; COLUMN_TYPE: string;
  }>(
    `SELECT IS_NULLABLE, COLUMN_TYPE
       FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME   = ?
        AND COLUMN_NAME  = ?
      LIMIT 1`,
    [table, column],
  );
  const row = (rows as Array<{ IS_NULLABLE: string; COLUMN_TYPE: string }>)[0];
  if (!row) return { exists: false, nullable: false, type: '' };
  return {
    exists:   true,
    nullable: row.IS_NULLABLE === 'YES',
    type:     row.COLUMN_TYPE,
  };
}

/**
 * Spec DB-FIX §1 — idempotent migration of `q365_signals.instrument_key`.
 *   1. ADD COLUMN if missing (VARCHAR(50) — wide enough for every
 *      observed NSE tradingsymbol; matches the cleanup-spec width).
 *   2. UPDATE every row where instrument_key IS NULL or '' to use the
 *      `symbol` value (the natural identifier the bootstrap derives
 *      from).
 *   3. MODIFY to NOT NULL so future inserts fail loud if a code path
 *      forgets to bind it.
 *
 * Returns counters for the final cleanup report.
 */
interface SchemaMigrationResult {
  added:     boolean;
  backfilled: number;
  nowNotNull: boolean;
}

async function migrateInstrumentKey(): Promise<SchemaMigrationResult> {
  const before = await inspectColumn('q365_signals', 'instrument_key');
  let added = false;
  if (!before.exists) {
    console.log('[CLEANUP] adding q365_signals.instrument_key VARCHAR(50)');
    await db.query(`ALTER TABLE q365_signals ADD COLUMN instrument_key VARCHAR(50) NULL`);
    added = true;
  }

  // Backfill — symbol column is the natural identifier we want.
  const { rows: countRows } = await db.query<{ c: number | string }>(
    `SELECT COUNT(*) AS c FROM q365_signals
      WHERE instrument_key IS NULL OR instrument_key = ''`,
  );
  const needsBackfill = Number((countRows as Array<{ c: number | string }>)[0]?.c ?? 0);
  if (needsBackfill > 0) {
    console.log(`[CLEANUP] backfilling instrument_key from symbol on ${needsBackfill} row(s)`);
    await db.query(
      `UPDATE q365_signals
          SET instrument_key = symbol
        WHERE instrument_key IS NULL OR instrument_key = ''`,
    );
  }

  // Tighten to NOT NULL — only after backfill so the ALTER doesn't
  // throw on legacy rows. Skip the ALTER when the column is already
  // NOT NULL to keep this safe to re-run. Preserve the EXISTING width
  // (VARCHAR(60) in some installs, VARCHAR(50) in others) so MODIFY
  // never truncates legitimate values; we only intend to flip
  // nullability, not shrink the column.
  const after = await inspectColumn('q365_signals', 'instrument_key');
  let nowNotNull = !after.nullable;
  if (after.nullable) {
    // `COLUMN_TYPE` looks like `varchar(60)` — pull the digits or fall
    // back to 50 (matches the spec) when parsing fails for some other
    // engine variant.
    const widthMatch = /\((\d+)\)/.exec(after.type);
    const width = widthMatch ? Number(widthMatch[1]) : 50;
    try {
      console.log(`[CLEANUP] tightening q365_signals.instrument_key to VARCHAR(${width}) NOT NULL`);
      await db.query(`ALTER TABLE q365_signals MODIFY instrument_key VARCHAR(${width}) NOT NULL`);
      nowNotNull = true;
    } catch (err) {
      // A few residual NULLs would block the MODIFY. Surface clearly
      // and leave the column nullable — the next cleanup run will
      // re-attempt after another backfill.
      console.warn(`[CLEANUP] could not tighten instrument_key to NOT NULL: ${(err as Error).message}`);
    }
  }
  return { added, backfilled: needsBackfill, nowNotNull };
}

function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let keepBootstrap = false;
  for (const a of argv) {
    if (a === '--dry-run')        dryRun = true;
    if (a === '--keep-bootstrap') keepBootstrap = true;
  }
  return { dryRun, keepBootstrap };
}

interface ScanCounts {
  total:                number;
  bootstrap:            number;
  duplicateRowCount:    number;
  duplicateSymbolPairs: number;
}

async function scan(): Promise<ScanCounts> {
  const { rows: totRows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_signals`,
  );
  const total = Number((totRows as Array<{ c: number | string }>)[0]?.c ?? 0);

  const { rows: bsRows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_signals
      WHERE generation_source = 'scripts/bootstrapNseData'`,
  );
  const bootstrap = Number((bsRows as Array<{ c: number | string }>)[0]?.c ?? 0);

  // Same (symbol, direction) appearing more than once. The COUNT-1
  // per group is the exact number of rows the dedupe step will drop.
  const { rows: dupGroups } = await db.query<{
    pairs: number; extras: number;
  }>(
    `SELECT COUNT(*) AS pairs, COALESCE(SUM(c - 1), 0) AS extras FROM (
       SELECT symbol, direction, COUNT(*) AS c
         FROM q365_signals
        GROUP BY symbol, direction
       HAVING c > 1
     ) AS g`,
  );
  const g = (dupGroups as Array<{ pairs: number | string; extras: number | string }>)[0] ?? { pairs: 0, extras: 0 };
  return {
    total,
    bootstrap,
    duplicateRowCount:    Number(g.extras ?? 0),
    duplicateSymbolPairs: Number(g.pairs  ?? 0),
  };
}

async function deleteBootstrap(): Promise<number> {
  const r = await db.query(
    `DELETE FROM q365_signals
      WHERE generation_source = 'scripts/bootstrapNseData'`,
  );
  return Number((r as { affectedRows?: number }).affectedRows ?? 0);
}

/**
 * Drop every row whose (symbol, direction) is shadowed by a more-recent
 * row (larger id) of the same pair. Result: at most one row per pair,
 * and that row is the latest. Self-join works on every MySQL ≥ 5.5.
 */
async function dedupeKeepLatest(): Promise<number> {
  const r = await db.query(
    `DELETE s1 FROM q365_signals s1
       INNER JOIN q365_signals s2
          ON s1.symbol    = s2.symbol
         AND s1.direction = s2.direction
         AND s1.id        < s2.id`,
  );
  return Number((r as { affectedRows?: number }).affectedRows ?? 0);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  console.log('[CLEANUP] START', { ...args, timestamp: new Date().toISOString() });

  const before = await scan();
  console.log('[CLEANUP] before', before);

  if (args.dryRun) {
    console.log('[CLEANUP] DRY-RUN — no DELETE issued');
    // Still INSPECT the schema so dry-run surfaces what the real
    // pass would migrate.
    const col = await inspectColumn('q365_signals', 'instrument_key');
    console.log('[CLEANUP] DRY-RUN schema check', { instrument_key: col });
    return 0;
  }

  // Spec DB-FIX §1 — schema migration runs FIRST so subsequent
  // DELETEs / dedupe operate on a column-complete table.
  const migration = await migrateInstrumentKey();
  console.log('[CLEANUP] schema migration', migration);

  let bootstrapDeleted = 0;
  if (!args.keepBootstrap) {
    bootstrapDeleted = await deleteBootstrap();
    console.log(`[CLEANUP] deleted ${bootstrapDeleted} old bootstrap row(s)`);
  } else {
    console.log('[CLEANUP] --keep-bootstrap: leaving bootstrap rows in place');
  }

  const dedupeDeleted = await dedupeKeepLatest();
  console.log(`[CLEANUP] deduped: dropped ${dedupeDeleted} stale (symbol,direction) duplicate(s)`);

  const after = await scan();
  console.log('[CLEANUP] after', after);
  console.log('[CLEANUP] DONE', {
    total_before:        before.total,
    total_after:         after.total,
    bootstrap_deleted:   bootstrapDeleted,
    duplicates_deleted:  dedupeDeleted,
    instrument_key_added:      migration.added,
    instrument_key_backfilled: migration.backfilled,
    instrument_key_not_null:   migration.nowNotNull,
  });
  return 0;
}

main()
  .then(async (code) => {
    try { await (db as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }
    process.exit(code);
  })
  .catch(async (err) => {
    console.error('[CLEANUP] FATAL', err);
    try { await (db as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }
    process.exit(1);
  });
