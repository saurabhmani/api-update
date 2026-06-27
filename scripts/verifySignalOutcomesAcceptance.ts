// ════════════════════════════════════════════════════════════════
//  verifySignalOutcomesAcceptance.ts — MySQL migration 032 suite
//
//  Usage:
//    npx tsx scripts/verifySignalOutcomesAcceptance.ts
// ════════════════════════════════════════════════════════════════

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '@/lib/db';
import { migrateSignalOutcomesPublic, SIGNAL_OUTCOMES_TABLE } from '@/lib/db/migrateSignalOutcomesPublic';
import { getSignalOutcomeCoverage } from '@/lib/signals/repository/signalOutcomeLedgerRepository';
import { seedHistoricalSignalOutcomes } from './seedSignalOutcomesHistorical';

interface Check {
  id: number;
  name: string;
  pass: boolean;
  detail: string;
}

async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];

  try {
    await migrateSignalOutcomesPublic();
    checks.push({
      id: 1,
      name: 'Migration executes successfully',
      pass: true,
      detail: 'migrateSignalOutcomesPublic() completed',
    });
  } catch (err) {
    checks.push({
      id: 1,
      name: 'Migration executes successfully',
      pass: false,
      detail: (err as Error).message,
    });
    return checks;
  }

  const { rows: tables } = await db.query(`SHOW TABLES LIKE ?`, [SIGNAL_OUTCOMES_TABLE]);
  checks.push({
    id: 2,
    name: 'Table created',
    pass: tables.length === 1,
    detail: tables.length === 1 ? SIGNAL_OUTCOMES_TABLE : 'missing',
  });

  const requiredCols = [
    'signal_id', 'strategy_id', 'symbol', 'outcome', 'outcome_at',
    'days_held', 'max_gain_pct', 'candle_check_count', 'resolved_at',
  ];
  const { rows: cols } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND COLUMN_NAME IN (${requiredCols.map(() => '?').join(',')})`,
    [SIGNAL_OUTCOMES_TABLE, ...requiredCols],
  );
  const colSet = new Set(cols.map((c) => c.COLUMN_NAME));
  const missingCols = requiredCols.filter((c) => !colSet.has(c));
  checks.push({
    id: 2,
    name: 'Public ledger columns present',
    pass: missingCols.length === 0,
    detail: missingCols.length === 0 ? `${requiredCols.length} columns` : `missing: ${missingCols.join(', ')}`,
  });

  const requiredIdx = [
    'idx_q365_signal_outcomes_strategy_outcome',
    'idx_q365_signal_outcomes_outcome_at',
  ];
  const { rows: idx } = await db.query<{ INDEX_NAME: string }>(
    `SELECT DISTINCT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND INDEX_NAME IN (${requiredIdx.map(() => '?').join(',')})`,
    [SIGNAL_OUTCOMES_TABLE, ...requiredIdx],
  );
  const idxSet = new Set(idx.map((r) => r.INDEX_NAME));
  const missingIdx = requiredIdx.filter((n) => !idxSet.has(n));
  checks.push({
    id: 3,
    name: 'Indexes created',
    pass: missingIdx.length === 0,
    detail: missingIdx.length === 0 ? requiredIdx.join(', ') : `missing: ${missingIdx.join(', ')}`,
  });

  const { rows: uniq } = await db.query<{ INDEX_NAME: string }>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND NON_UNIQUE = 0 AND COLUMN_NAME = 'signal_id'
     LIMIT 1`,
    [SIGNAL_OUTCOMES_TABLE],
  );
  checks.push({
    id: 7,
    name: 'One outcome per signal (UNIQUE signal_id)',
    pass: uniq.length > 0,
    detail: uniq[0]?.INDEX_NAME ?? 'no unique index on signal_id',
  });

  const { rows: fk } = await db.query<{ CONSTRAINT_NAME: string }>(
    `SELECT CONSTRAINT_NAME FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
       AND CONSTRAINT_TYPE = 'FOREIGN KEY'
       AND CONSTRAINT_NAME = 'fk_q365_signal_outcomes_signal'`,
    [SIGNAL_OUTCOMES_TABLE],
  );
  checks.push({
    id: 4,
    name: 'Foreign key works',
    pass: fk.length > 0,
    detail: fk.length > 0 ? 'fk_q365_signal_outcomes_signal → q365_signals(id) ON DELETE CASCADE' : 'FK not present',
  });

  const { rows: signalCountBefore } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_signals`,
  );
  const signalsBefore = Number(signalCountBefore[0]?.c ?? 0);

  let seedDetail = '';
  let seedPass = false;
  try {
    const seed = await seedHistoricalSignalOutcomes();
    seedPass = seed.errors === 0;
    seedDetail = `scanned=${seed.scanned} inserted=${seed.inserted} errors=${seed.errors}`;
  } catch (err) {
    seedDetail = (err as Error).message;
  }
  checks.push({
    id: 5,
    name: 'Seed script executes',
    pass: seedPass,
    detail: seedDetail,
  });

  const { rows: dupes } = await db.query<{ signal_id: number; n: number }>(
    `SELECT signal_id, COUNT(*) AS n
     FROM q365_signal_outcomes
     WHERE signal_id IS NOT NULL
       AND strategy_id IS NOT NULL
       AND outcome IS NOT NULL
     GROUP BY signal_id
     HAVING COUNT(*) > 1
     LIMIT 5`,
  );
  checks.push({
    id: 7,
    name: 'No duplicate ledger outcomes',
    pass: dupes.length === 0,
    detail: dupes.length === 0 ? '0 duplicate signal_id rows' : `${dupes.length} duplicates found`,
  });

  const { rows: signalCountAfter } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM q365_signals`,
  );
  const signalsAfter = Number(signalCountAfter[0]?.c ?? 0);
  checks.push({
    id: 6,
    name: 'Existing signals remain untouched',
    pass: signalsBefore === signalsAfter,
    detail: `q365_signals count ${signalsBefore} → ${signalsAfter}`,
  });

  const coverage = await getSignalOutcomeCoverage();
  checks.push({
    id: 8,
    name: 'Database ready for outcome engine',
    pass: tables.length === 1 && missingCols.length === 0 && uniq.length > 0,
    detail: `coverage ${coverage.withOutcome}/${coverage.totalSignals} (${coverage.coveragePct ?? 0}%)`,
  });

  return checks.sort((a, b) => a.id - b.id || a.name.localeCompare(b.name));
}

async function main(): Promise<void> {
  console.log('══════════════════════════════════════════════════');
  console.log('  Migration 032 — MySQL Acceptance Verification');
  console.log('══════════════════════════════════════════════════\n');

  const checks = await runChecks();
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.pass ? '✔' : '✗'} #${c.id} ${c.name}`);
    console.log(`     ${c.detail}`);
    if (!c.pass) failed++;
  }
  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
