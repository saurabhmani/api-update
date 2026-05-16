import './loadEnv';
import { db } from '../lib/db';

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n
       FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [name],
  );
  return Number((rows[0] as any).n) > 0;
}

async function latestColumn(table: string): Promise<string | null> {
  const candidates = ['updated_at', 'created_at', 'run_date', 'snapshot_date', 'evaluated_at', 'graded_at', 'generated_at'];
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [table],
  );
  const cols = new Set((rows as any[]).map((r) => String(r.column_name || r.COLUMN_NAME).toLowerCase()));
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

async function reportTable(label: string, table: string) {
  if (!(await tableExists(table))) {
    console.log(`  ${label} [${table}]: TABLE MISSING`);
    return;
  }
  const { rows: cntRows } = await db.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
  const total = Number((cntRows[0] as any).n);

  const tsCol = await latestColumn(table);
  if (!tsCol) {
    console.log(`  ${label} [${table}]: total=${total} (no timestamp column found)`);
    return;
  }

  const { rows: todayRows } = await db.query(
    `SELECT COUNT(*) AS n FROM \`${table}\` WHERE DATE(\`${tsCol}\`) = CURDATE()`,
  );
  const today = Number((todayRows[0] as any).n);

  const { rows: latestRows } = await db.query(
    `SELECT MAX(\`${tsCol}\`) AS latest FROM \`${table}\``,
  );
  const latest = (latestRows[0] as any).latest;

  console.log(`  ${label} [${table}]: total=${total}  today=${today}  latest(${tsCol})=${latest ?? '(null)'}`);
}

(async () => {
  console.log('═══════════════════════════════════════════════════════');
  console.log(' LEARNING SCHEDULER — RUNTIME VERIFICATION');
  console.log(` now = ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════\n');

  // 1. Job-run audit log (authoritative evidence the scheduler fired)
  console.log('[1] Scheduler job-run audit (q365_learning_job_runs):');
  if (await tableExists('q365_learning_job_runs')) {
    const { rows } = await db.query(
      `SELECT job_name, status, duration_ms,
              JSON_UNQUOTE(counts_json) AS counts, error_msg, run_at
         FROM q365_learning_job_runs
        ORDER BY run_at DESC
        LIMIT 10`,
    );
    if ((rows as any[]).length === 0) {
      console.log('  NO ROWS — scheduler has never run against this DB.');
    } else {
      for (const r of rows as any[]) {
        console.log(
          `  ${r.run_at}  ${String(r.job_name).padEnd(32)}  ` +
          `status=${r.status}  dur=${r.duration_ms}ms  counts=${r.counts ?? '-'}` +
          (r.error_msg ? `  err=${r.error_msg}` : ''),
        );
      }
    }
  } else {
    console.log('  q365_learning_job_runs table missing — scheduler never bootstrapped.');
  }

  // 2. Output tables each learning job writes
  console.log('\n[2] Output tables:');
  await reportTable('A. outcomes           ', 'q365_signal_outcomes');
  await reportTable('B. confidence calib   ', 'q365_confidence_calibration');
  await reportTable('C. strategy perf snap ', 'q365_strategy_performance_snapshots');
  await reportTable('D. adaptive recs      ', 'q365_adaptive_recommendations');
  await reportTable('E. manip watchlist    ', 'q365_manipulation_watchlist');
  await reportTable('E. manip detector snap', 'q365_manipulation_detector_snapshots');

  // 3. Verdict
  console.log('\n[3] Verdict:');
  if (await tableExists('q365_learning_job_runs')) {
    const { rows } = await db.query(
      `SELECT COUNT(DISTINCT job_name) AS n FROM q365_learning_job_runs
        WHERE DATE(run_at) = CURDATE() AND status = 'completed'`,
    );
    const okToday = Number((rows[0] as any).n);
    const { rows: lastRows } = await db.query(
      `SELECT MAX(run_at) AS latest FROM q365_learning_job_runs`,
    );
    const lastRun = (lastRows[0] as any).latest;
    console.log(`  completed jobs today: ${okToday}`);
    console.log(`  last execution:       ${lastRun ?? '(never)'}`);
    console.log(`  auto-running today:   ${okToday >= 5 ? 'YES (all 5 jobs)' : okToday > 0 ? `PARTIAL (${okToday}/5)` : 'NO'}`);
  }

  process.exit(0);
})().catch((e) => {
  console.error('VERIFY FAILED:', e);
  process.exit(1);
});
