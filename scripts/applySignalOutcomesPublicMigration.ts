/**
 * scripts/applySignalOutcomesPublicMigration.ts
 *
 * Applies migration 032 — Public Signal Ledger (MySQL).
 *
 * Run:
 *   npm run db:migrate-signal-outcomes
 *   npx tsx scripts/applySignalOutcomesPublicMigration.ts
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import {
  migrateSignalOutcomesPublic,
  SIGNAL_OUTCOMES_TABLE,
  SIGNAL_OUTCOMES_PUBLIC_COLUMNS,
  SIGNAL_OUTCOMES_PUBLIC_INDEXES,
} from '../src/lib/db/migrateSignalOutcomesPublic';

const UNIQUE_SIGNAL = 'uq_q365_signal_outcomes_signal';

async function main(): Promise<void> {
  console.log('='.repeat(72));
  console.log('PUBLIC SIGNAL LEDGER — MySQL MIGRATION 032');
  console.log('='.repeat(72));
  console.log('');

  await migrateSignalOutcomesPublic();
  console.log('');

  const { rows: tables } = await db.query(`SHOW TABLES LIKE ?`, [SIGNAL_OUTCOMES_TABLE]);
  const tableOk = tables.length === 1;
  console.log(`Table: ${tableOk ? '✅' : '❌'}  ${SIGNAL_OUTCOMES_TABLE}`);

  const { rows: cols } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND COLUMN_NAME IN (${SIGNAL_OUTCOMES_PUBLIC_COLUMNS.map(() => '?').join(',')})`,
    [SIGNAL_OUTCOMES_TABLE, ...SIGNAL_OUTCOMES_PUBLIC_COLUMNS],
  );
  const present = new Set(cols.map((r) => r.COLUMN_NAME));
  let allOk = tableOk;
  for (const col of SIGNAL_OUTCOMES_PUBLIC_COLUMNS) {
    const ok = present.has(col);
    if (!ok) allOk = false;
    console.log(`  ${ok ? '✅' : '❌'}  ${col}`);
  }

  const { rows: idx } = await db.query<{ INDEX_NAME: string; COLUMN_NAME: string; NON_UNIQUE: number }>(
    `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND INDEX_NAME IN (${SIGNAL_OUTCOMES_PUBLIC_INDEXES.map(() => '?').join(',')})`,
    [SIGNAL_OUTCOMES_TABLE, ...SIGNAL_OUTCOMES_PUBLIC_INDEXES],
  );
  const idxSet = new Set(idx.map((r) => r.INDEX_NAME));

  const { rows: uniqSignal } = await db.query<{ INDEX_NAME: string }>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND NON_UNIQUE = 0 AND COLUMN_NAME = 'signal_id'
     LIMIT 1`,
    [SIGNAL_OUTCOMES_TABLE],
  );
  const hasSignalIdUnique = uniqSignal.length > 0;

  for (const name of SIGNAL_OUTCOMES_PUBLIC_INDEXES) {
    if (name === UNIQUE_SIGNAL) {
      const ok = idxSet.has(name) || hasSignalIdUnique;
      if (!ok) allOk = false;
      console.log(`  ${ok ? '✅' : '❌'}  unique on signal_id (${name} or legacy)`);
      continue;
    }
    const ok = idxSet.has(name);
    if (!ok) allOk = false;
    console.log(`  ${ok ? '✅' : '❌'}  index ${name}`);
  }

  console.log('');
  console.log(allOk ? 'RESULT: Migration 032 applied successfully.' : 'RESULT: Verification failed.');
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
