/**
 * scripts/fixManipulationTables.ts
 *
 *  One-shot repair script for q365_manipulation_events when its schema
 *  has drifted away from what migrate.ts / the route code expect.
 *
 *  Symptom this fixes:
 *    [API manipulation buildSummary] topAlerts query failed:
 *      Error: Unknown column 'symbol' in 'field list'
 *      Error: Unknown column 'event_date' in 'field list'
 *
 *  Why this happens:
 *    The migration uses `CREATE TABLE IF NOT EXISTS`. If an older /
 *    partial version of the table was created at some point, the
 *    `IF NOT EXISTS` clause SILENTLY skips the create on subsequent
 *    boots — even though the existing schema is wrong. So the broken
 *    schema is stuck and the route 500s on every read.
 *
 *  What this script does:
 *    1. Inspect the current `q365_manipulation_events` columns.
 *    2. If the table is missing the core columns the code requires
 *       (symbol + event_date), drop both manipulation tables.
 *    3. Re-run the canonical migration so they are rebuilt with the
 *       correct schema + indexes.
 *    4. Verify the new schema and exit.
 *
 *  Data safety:
 *    If the table HAS data AND has the core columns, the script does
 *    nothing destructive — it just runs the migration's idempotent
 *    ALTERs (e.g. add `status` column) and exits. The drop only fires
 *    when the table is structurally unusable, which means no row in it
 *    was ever queryable by the current code anyway.
 *
 *  How to run on the VPS:
 *    cd /var/www/api-update
 *    npm run fix:manipulation
 *    pm2 restart quantorus365
 */

// Load env from .env.local (the codebase convention — server.js does
// the same). Plain `dotenv/config` only reads `.env`, which this repo
// doesn't use, so MySQL config wasn't being picked up.
import * as path from 'node:path';
import * as dotenv from 'dotenv';
dotenv.config({
  path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local'),
});

import { db } from '../src/lib/db';
import { migrateManipulationEngineTables } from '../src/lib/manipulation-engine/repository/migrate';

const REQUIRED_COLUMNS = [
  'symbol',
  'event_date',
  'event_type',
  'severity',
  'confidence',
  'score',
];

// `--force` always drops and recreates regardless of detected schema —
// useful when you've seen ER_BAD_FIELD_ERROR repeatedly and just want
// a guaranteed clean rebuild. Without it the script preserves data
// when the schema looks healthy.
const FORCE = process.argv.includes('--force');

async function describeTable(table: string): Promise<string[]> {
  try {
    const { rows } = await db.query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
      [table],
    );
    return rows.map((r) => String((r as any).COLUMN_NAME).toLowerCase());
  } catch {
    return [];
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

async function rowCount(table: string): Promise<number> {
  try {
    const { rows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM \`${table}\``,
    );
    return Number((rows[0] as any)?.c ?? 0);
  } catch {
    // If the broken schema makes COUNT(*) fail, treat it as unknown.
    return -1;
  }
}

function bar(): void {
  console.log('─'.repeat(60));
}

async function main(): Promise<void> {
  bar();
  console.log('Manipulation tables — repair script');
  bar();

  // Print which DB we just connected to so the operator can confirm
  // it matches what their dev server / production app uses. Past bug
  // report: script ran "successfully" against one DB while the dev
  // server pointed at a different one, so the fix was never visible.
  try {
    const { rows } = await db.query<{ db: string; host: string }>(
      `SELECT DATABASE() AS db, @@hostname AS host`,
    );
    const r = (rows[0] as any) ?? {};
    console.log(`Connected to DB:  ${r.db ?? '(unknown)'}`);
    console.log(`MySQL host:       ${r.host ?? '(unknown)'}`);
    console.log(
      `(env MYSQL_HOST=${process.env.MYSQL_HOST ?? '(unset)'}, ` +
      `MYSQL_DATABASE=${process.env.MYSQL_DATABASE ?? '(unset)'})`,
    );
  } catch (err) {
    console.warn('Could not read DB identity:', (err as any)?.message);
  }
  bar();

  const exists = await tableExists('q365_manipulation_events');
  if (!exists) {
    console.log('q365_manipulation_events does not exist yet.');
    console.log('Running migration to create it from scratch…');
    await migrateManipulationEngineTables();
    console.log('Done. Tables created.');
    bar();
    return;
  }

  const cols = await describeTable('q365_manipulation_events');
  const missing = REQUIRED_COLUMNS.filter((c) => !cols.includes(c));

  console.log(`q365_manipulation_events has ${cols.length} column(s).`);
  console.log(`  present : ${cols.join(', ') || '(none)'}`);
  console.log(`  missing : ${missing.join(', ') || '(none — schema looks healthy)'}`);
  if (FORCE) {
    console.log('  --force given: will drop + recreate anyway.');
  }
  bar();

  if (missing.length === 0 && !FORCE) {
    // Schema is OK — just run migration to pick up any newer additions
    // (idempotent ALTERs like the `status` column).
    console.log('Schema looks correct. Running idempotent migration to');
    console.log('pick up any newer columns / indexes.');
    console.log('(Pass --force to drop + recreate anyway.)');
    await migrateManipulationEngineTables();
    console.log('Done. No destructive action taken.');
    bar();
    return;
  }

  // Missing core columns → table is unusable. Check if it has data
  // we'd be losing (extremely unlikely if the queryable columns
  // aren't even there, but report the count for transparency).
  const rows = await rowCount('q365_manipulation_events');
  console.log(
    `Existing row count: ${rows < 0 ? 'unknown (schema is broken — COUNT failed)' : rows}`,
  );
  if (rows > 0) {
    console.log(
      'NOTE: rows exist but the table is missing columns the current code needs.',
    );
    console.log(
      'Those rows are not readable by the app today and would break any read path.',
    );
    console.log('Proceeding to drop + recreate.');
  }

  console.log('');
  console.log('Dropping broken tables…');
  // Drop both manipulation tables so the migration can rebuild a
  // consistent set. q365_manipulation_snapshots stores per-symbol
  // aggregates that link by symbol/date — if events is wrong, snapshots
  // is likely also out of date with the engine code.
  await db.query('DROP TABLE IF EXISTS q365_manipulation_detector_results');
  await db.query('DROP TABLE IF EXISTS q365_manipulation_penalties');
  await db.query('DROP TABLE IF EXISTS q365_signal_manipulation_links');
  await db.query('DROP TABLE IF EXISTS q365_manipulation_snapshots');
  await db.query('DROP TABLE IF EXISTS q365_manipulation_events');
  console.log('Dropped.');

  console.log('');
  console.log('Re-running migration…');
  await migrateManipulationEngineTables();
  console.log('Migration complete.');

  console.log('');
  console.log('Verifying new schema…');
  const newCols = await describeTable('q365_manipulation_events');
  const stillMissing = REQUIRED_COLUMNS.filter((c) => !newCols.includes(c));
  if (stillMissing.length > 0) {
    console.error(
      `FAILED: columns still missing after migration: ${stillMissing.join(', ')}`,
    );
    console.error('The migration code itself may be wrong — investigate migrate.ts.');
    process.exitCode = 1;
    return;
  }
  console.log(`OK — q365_manipulation_events now has ${newCols.length} columns:`);
  console.log(`     ${newCols.join(', ')}`);
  bar();
  console.log('Done. Restart the app: pm2 restart quantorus365');
  bar();
}

main()
  .catch((err) => {
    console.error('FATAL:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Best-effort close so the script exits cleanly. db.end() is the
    // right call but isn't surfaced through @/lib/db; let process exit
    // naturally — open pool will be torn down with it.
    setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
  });
