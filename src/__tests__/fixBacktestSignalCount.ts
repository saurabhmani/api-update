// ════════════════════════════════════════════════════════════════
//  One-shot backfill: reconcile backtest_runs.signal_count with
//  the actual number of persisted rows in backtest_signals.
//
//  Safe to re-run. Idempotent — each UPDATE sets the column to a
//  value derived from a SELECT COUNT, so running twice is a no-op.
// ════════════════════════════════════════════════════════════════

import './loadEnv';
import { db } from '../lib/db';

(async () => {
  // 1. Find every run where stored count disagrees with actual rows.
  const { rows: mismatches } = await db.query(
    `SELECT r.id, r.run_id, r.signal_count AS stored_count,
            COALESCE(s.n, 0)            AS actual_count
       FROM backtest_runs r
       LEFT JOIN (
         SELECT run_id, COUNT(*) AS n
           FROM backtest_signals
          GROUP BY run_id
       ) s ON s.run_id = r.run_id
      WHERE r.signal_count <> COALESCE(s.n, 0)
      ORDER BY r.started_at DESC`,
    [],
  );

  console.log(`Found ${(mismatches as any[]).length} run(s) with signal_count mismatch:\n`);
  for (const m of mismatches as any[]) {
    console.log(`  run_id=${m.run_id}  stored=${m.stored_count}  actual=${m.actual_count}  Δ=${Number(m.stored_count) - Number(m.actual_count)}`);
  }

  if ((mismatches as any[]).length === 0) {
    console.log('\nNothing to fix. All runs already consistent.');
    process.exit(0);
  }

  // 2. Backfill in a single SQL statement — no row-by-row work needed.
  console.log('\nApplying backfill UPDATE ...');
  const { rows: updated } = await db.query(
    `UPDATE backtest_runs r
       LEFT JOIN (
         SELECT run_id, COUNT(*) AS n
           FROM backtest_signals
          GROUP BY run_id
       ) s ON s.run_id = r.run_id
        SET r.signal_count = COALESCE(s.n, 0)
      WHERE r.signal_count <> COALESCE(s.n, 0)`,
    [],
  );
  console.log('  done.');

  // 3. Verify — recount mismatches after the UPDATE.
  const { rows: remaining } = await db.query(
    `SELECT COUNT(*) AS n FROM backtest_runs r
       LEFT JOIN (
         SELECT run_id, COUNT(*) AS n FROM backtest_signals GROUP BY run_id
       ) s ON s.run_id = r.run_id
      WHERE r.signal_count <> COALESCE(s.n, 0)`,
    [],
  );
  const n = Number((remaining[0] as any).n);
  console.log(`\nRemaining mismatches after backfill: ${n}`);
  console.log(n === 0 ? 'RESULT: CONSISTENT' : 'RESULT: STILL INCONSISTENT');

  process.exit(n === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
