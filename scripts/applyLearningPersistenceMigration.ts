/**
 * scripts/applyLearningPersistenceMigration.ts
 *
 * Applies the Learning Engine fallback persistence table
 * `q365_signal_learning_observations` (minimal Phase-6 shape).
 *
 * Idempotent — safe to re-run. Uses CREATE TABLE IF NOT EXISTS plus
 * additive column/index ensures for installs that already have the
 * daily-report draft schema from 011.
 *
 * Run:
 *   npx tsx scripts/applyLearningPersistenceMigration.ts
 *
 * Raw SQL reference:
 *   migrations/mysql/012_q365_signal_learning_observations_fallback.sql
 *
 * Future replacement:
 *   migrations/postgres/011_q365_daily_signal_reports.sql.proposal
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import {
  migrateLearningPersistence,
  LEARNING_PERSISTENCE_TABLE,
  LEARNING_PERSISTENCE_COLUMNS,
  LEARNING_PERSISTENCE_INDEXES,
} from '../src/lib/db/migrateLearningPersistence';

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('LEARNING ENGINE — FALLBACK PERSISTENCE MIGRATION');
  console.log('='.repeat(72));
  console.log('');

  console.log('[1/4] Running migrateLearningPersistence()…');
  await migrateLearningPersistence();
  console.log('');

  console.log('[2/4] Verifying table exists.');
  const { rows: tables } = await db.query(
    `SHOW TABLES LIKE ?`,
    [LEARNING_PERSISTENCE_TABLE],
  );
  const tableOk = tables.length === 1;
  console.log(`     ${tableOk ? '✅' : '❌'}  ${LEARNING_PERSISTENCE_TABLE} (${tables.length} row)`);
  console.log('');

  console.log('[3/4] Verifying fallback columns.');
  const { rows: cols } = await db.query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
    `SELECT COLUMN_NAME, DATA_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND COLUMN_NAME IN (${LEARNING_PERSISTENCE_COLUMNS.map(() => '?').join(',')})
     ORDER BY COLUMN_NAME`,
    [LEARNING_PERSISTENCE_TABLE, ...LEARNING_PERSISTENCE_COLUMNS],
  );
  const present = new Set(cols.map((r) => r.COLUMN_NAME));
  let allOk = tableOk;
  for (const col of LEARNING_PERSISTENCE_COLUMNS) {
    const ok = present.has(col);
    if (!ok) allOk = false;
    const row = cols.find((r) => r.COLUMN_NAME === col);
    console.log(`     ${ok ? '✅' : '❌'}  ${col.padEnd(18)}  ${row?.DATA_TYPE ?? '(missing)'}`);
  }
  console.log('');

  console.log('[4/4] Verifying health-probe indexes (idx_signal, idx_strategy).');
  const { rows: idx } = await db.query<{ INDEX_NAME: string; COLUMN_NAME: string }>(
    `SELECT INDEX_NAME, COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND INDEX_NAME IN (${LEARNING_PERSISTENCE_INDEXES.map(() => '?').join(',')})
     ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [LEARNING_PERSISTENCE_TABLE, ...LEARNING_PERSISTENCE_INDEXES],
  );
  const byName = new Map<string, string[]>();
  for (const r of idx) {
    const list = byName.get(r.INDEX_NAME) ?? [];
    list.push(r.COLUMN_NAME);
    byName.set(r.INDEX_NAME, list);
  }
  const expected: Record<string, string> = { idx_signal: 'signal_id', idx_strategy: 'strategy_id' };
  for (const name of LEARNING_PERSISTENCE_INDEXES) {
    const cols = byName.get(name) ?? [];
    const ok = cols.length === 1 && cols[0] === expected[name];
    if (!ok) allOk = false;
    console.log(`     ${ok ? '✅' : '❌'}  ${name} → ${cols.join(',') || '(missing)'}  (expected ${expected[name]})`);
  }
  console.log('');

  console.log('='.repeat(72));
  console.log(allOk
    ? 'RESULT: Learning persistence fallback applied successfully.'
    : 'RESULT: Migration ran but verification failed — check logs above.');
  console.log('='.repeat(72));
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('='.repeat(72));
  console.error('MIGRATION FAILED');
  console.error('='.repeat(72));
  console.error(err);
  process.exit(1);
});
