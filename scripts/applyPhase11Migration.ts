/**
 * scripts/applyPhase11Migration.ts
 *
 * One-shot runner that applies the Phase-11 schema migration
 * (8 columns + 4 JSON blobs + 2 indexes added by Phase-11) and
 * confirms each new column exists in q365_signals.
 *
 * Idempotent — safe to re-run. The underlying ensureColumn /
 * ensureIndex helpers in migrateSignalEngine.ts probe
 * INFORMATION_SCHEMA before each ALTER, so a second run is a
 * no-op.
 *
 * Run:
 *   npx tsx scripts/applyPhase11Migration.ts
 *
 * Equivalent raw SQL (for hosts where running tsx is awkward):
 *   ALTER TABLE q365_signals
 *     ADD COLUMN stress_survival_score        DECIMAL(5,2)   NULL,
 *     ADD COLUMN recommended_quantity         INT            NULL,
 *     ADD COLUMN recommended_capital          DECIMAL(14,2)  NULL,
 *     ADD COLUMN live_valid                   TINYINT(1)     NULL,
 *     ADD COLUMN rejection_codes_json         JSON           NULL,
 *     ADD COLUMN rejection_reasons_json       JSON           NULL,
 *     ADD COLUMN live_validation_reasons_json JSON           NULL,
 *     ADD COLUMN explanation_json             JSON           NULL,
 *     ADD INDEX  idx_q365sig_stress_survival  (stress_survival_score),
 *     ADD INDEX  idx_q365sig_live_valid       (live_valid);
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { migrateSignalEngine } from '../src/lib/db/migrateSignalEngine';
import { db } from '../src/lib/db';

const PHASE_11_COLUMNS = [
  'stress_survival_score',
  'recommended_quantity',
  'recommended_capital',
  'live_valid',
  'rejection_codes_json',
  'rejection_reasons_json',
  'live_validation_reasons_json',
  'explanation_json',
];

async function main() {
  console.log('='.repeat(72));
  console.log('PHASE-11 MIGRATION RUNNER');
  console.log('='.repeat(72));
  console.log('');

  console.log('[1/3] Running migrateSignalEngine() — idempotent, safe to re-run.');
  await migrateSignalEngine();
  console.log('');

  console.log('[2/3] Verifying every Phase-11 column exists on q365_signals.');
  const { rows } = await db.query<{ COLUMN_NAME: string; DATA_TYPE: string }>(
    `SELECT COLUMN_NAME, DATA_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_signals'
       AND COLUMN_NAME IN (${PHASE_11_COLUMNS.map(() => '?').join(',')})
     ORDER BY COLUMN_NAME`,
    PHASE_11_COLUMNS,
  );
  const present = new Set(rows.map((r) => r.COLUMN_NAME));
  let allOk = true;
  for (const col of PHASE_11_COLUMNS) {
    const ok = present.has(col);
    if (!ok) allOk = false;
    const row = rows.find((r) => r.COLUMN_NAME === col);
    console.log(`     ${ok ? '✅' : '❌'}  ${col.padEnd(34)}  ${row?.DATA_TYPE ?? '(missing)'}`);
  }
  console.log('');

  console.log('[3/3] Verifying Phase-11 indexes exist.');
  const { rows: idx } = await db.query<{ INDEX_NAME: string }>(
    `SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_signals'
       AND INDEX_NAME IN ('idx_q365sig_stress_survival', 'idx_q365sig_live_valid')`,
  );
  const idxPresent = new Set(idx.map((r) => r.INDEX_NAME));
  for (const name of ['idx_q365sig_stress_survival', 'idx_q365sig_live_valid']) {
    const ok = idxPresent.has(name);
    if (!ok) allOk = false;
    console.log(`     ${ok ? '✅' : '❌'}  ${name}`);
  }
  console.log('');

  console.log('='.repeat(72));
  console.log(allOk
    ? 'RESULT: Phase-11 migration applied successfully.'
    : 'RESULT: Migration ran but some columns/indexes are missing — check logs above.');
  console.log('='.repeat(72));
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error('='.repeat(72));
  console.error('MIGRATION FAILED');
  console.error('='.repeat(72));
  if (err.code === 'ECONNREFUSED') {
    console.error('  MySQL is not reachable. Check that mysqld is running and');
    console.error('  .env.local has the right MYSQL_HOST / MYSQL_PORT / credentials.');
  } else {
    console.error(err);
  }
  process.exit(1);
});
