/**
 * unblockExecutionLock.ts
 *
 * Clears stuck pipeline locks so /api/run-signal-engine can run again.
 *
 * Usage:
 *   npx tsx scripts/unblockExecutionLock.ts
 *   npx tsx scripts/unblockExecutionLock.ts --dry-run
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { db } from '@/lib/db';
import {
  getLockRow,
  recoverStaleExecutionLock,
  recoverStaleManualRun,
  releaseExecutionLock,
  istCalendarDate,
} from '@/lib/pipeline/runLockRepo';

const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTION_LOCK_DATE = '2000-01-01';

async function listActiveLocks(): Promise<void> {
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT run_type, run_date, status, request_source, started_at, completed_at, error_message
       FROM q365_pipeline_run_locks
      WHERE status = 'started'
         OR (run_type = 'system' AND run_date = ?)
      ORDER BY run_type, run_date`,
    [EXECUTION_LOCK_DATE],
  );
  console.log('\nActive / system locks:');
  if (!rows.length) {
    console.log('  (none)');
    return;
  }
  for (const row of rows) {
    console.log(' ', JSON.stringify(row));
  }
}

async function forceClearExecutionLock(): Promise<void> {
  const row = await getLockRow('system', EXECUTION_LOCK_DATE);
  if (!row) {
    console.log('[execution] no system lock row');
    return;
  }
  if (row.status !== 'started') {
    console.log(`[execution] row status=${row.status} — deleting sentinel row`);
    if (!DRY_RUN) {
      await db.query(
        `DELETE FROM q365_pipeline_run_locks WHERE run_type='system' AND run_date=?`,
        [EXECUTION_LOCK_DATE],
      );
    }
    return;
  }
  console.log(`[execution] clearing started lock (batch=${row.request_source})`);
  if (!DRY_RUN) {
    await releaseExecutionLock();
    const still = await getLockRow('system', EXECUTION_LOCK_DATE);
    if (still?.status === 'started') {
      await db.query(
        `UPDATE q365_pipeline_run_locks
            SET status='failed', completed_at=NOW(),
                error_message='operator unblockExecutionLock'
          WHERE run_type='system' AND run_date=?`,
        [EXECUTION_LOCK_DATE],
      );
    }
  }
}

async function forceClearStuckManualLock(): Promise<void> {
  const { rows } = await db.query<{ id: number; run_date: string | Date }>(
    `SELECT id, run_date FROM q365_pipeline_run_locks
      WHERE run_type='manual' AND status='started'`,
  );
  if (!rows.length) {
    console.log('[manual] no stuck started rows');
    return;
  }
  for (const row of rows) {
    const runDate = row.run_date instanceof Date
      ? row.run_date.toISOString().slice(0, 10)
      : String(row.run_date).slice(0, 10);
    console.log(`[manual] marking stuck started row as failed (id=${row.id}, run_date=${runDate})`);
    if (!DRY_RUN) {
      await db.query(
        `UPDATE q365_pipeline_run_locks
            SET status='failed', completed_at=NOW(),
                error_message='operator unblockExecutionLock'
          WHERE id=? AND status='started'`,
        [row.id],
      );
    }
  }
}

async function main(): Promise<void> {
  console.log(`\n=== UNBLOCK EXECUTION LOCK ${DRY_RUN ? '(dry-run)' : ''} ===\n`);
  await listActiveLocks();

  if (!DRY_RUN) {
    await recoverStaleExecutionLock();
    await recoverStaleManualRun();
  }

  await forceClearExecutionLock();
  await forceClearStuckManualLock();

  if (!DRY_RUN) {
    await listActiveLocks();
    const exec = await getLockRow('system', EXECUTION_LOCK_DATE);
    const { rows: started } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_pipeline_run_locks WHERE status='started'`,
    );
    const blocked = exec?.status === 'started' || Number(started[0]?.c ?? 0) > 0;
    if (blocked) {
      console.error('\nFAIL — a started lock row remains');
      process.exit(1);
    }
    console.log('\nOK — execution lock cleared. Retry POST /api/run-signal-engine?force=true');
    console.log('Note: if the dev server still returns 409, restart `npm run dev` to clear in-process inFlight.');
  }
}

main().catch((err) => {
  console.error('[unblockExecutionLock] fatal:', err);
  process.exit(2);
});
