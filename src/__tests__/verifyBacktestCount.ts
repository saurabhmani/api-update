import './loadEnv';
import { db } from '../lib/db';

(async () => {
  // Pick the run that had the largest original delta (1263 -> 345)
  const runId = '62b788ca-7741-40cc-ac66-4e20f0048384';

  const { rows: stored } = await db.query(
    `SELECT id, run_id, signal_count FROM backtest_runs WHERE run_id = ?`,
    [runId],
  );
  const { rows: actual } = await db.query(
    `SELECT COUNT(*) AS n FROM backtest_signals WHERE run_id = ?`,
    [runId],
  );

  const storedCount = Number((stored[0] as any).signal_count);
  const actualCount = Number((actual[0] as any).n);

  console.log(`Run: ${runId}`);
  console.log(`  backtest_runs.signal_count       = ${storedCount}`);
  console.log(`  COUNT(*) FROM backtest_signals   = ${actualCount}`);
  console.log(`  match: ${storedCount === actualCount ? 'YES ✓' : 'NO ✗'}`);

  // Global check: all runs consistent?
  const { rows: allRuns } = await db.query(
    `SELECT COUNT(*) AS n FROM backtest_runs r
       LEFT JOIN (
         SELECT run_id, COUNT(*) AS n FROM backtest_signals GROUP BY run_id
       ) s ON s.run_id = r.run_id
      WHERE r.signal_count <> COALESCE(s.n, 0)`,
    [],
  );
  console.log(`\nGlobal: runs still inconsistent = ${(allRuns[0] as any).n}`);

  process.exit(storedCount === actualCount ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
