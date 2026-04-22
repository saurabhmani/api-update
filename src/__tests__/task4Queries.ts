import './loadEnv';
import { db } from '../lib/db';

async function run(label: string, sql: string) {
  try {
    const { rows } = await db.query(sql, []);
    console.log(`${label}\n  ${JSON.stringify(rows[0])}`);
  } catch (e) {
    console.log(`${label}\n  ERROR: ${(e as Error).message}`);
  }
}

(async () => {
  console.log('─── TASK 4 — data-updated-today queries ───\n');

  await run(
    '1. q365_signal_outcomes today (by created_at or evaluated_at):',
    `SELECT COUNT(*) AS n FROM q365_signal_outcomes WHERE DATE(evaluated_at) = CURDATE()`,
  );
  await run(
    '2. q365_confidence_calibration today:',
    `SELECT COUNT(*) AS n FROM q365_confidence_calibration WHERE DATE(computed_at) = CURDATE()`,
  );
  await run(
    '3. q365_strategy_performance_snapshots today:',
    `SELECT COUNT(*) AS n FROM q365_strategy_performance_snapshots WHERE DATE(computed_at) = CURDATE()`,
  );
  await run(
    '4. q365_manipulation_snapshots today:',
    `SELECT COUNT(*) AS n FROM q365_manipulation_snapshots WHERE DATE(created_at) = CURDATE()`,
  );
  await run(
    '5. q365_learning_job_runs today (completed):',
    `SELECT COUNT(*) AS n FROM q365_learning_job_runs
       WHERE DATE(run_at) = CURDATE() AND status = 'success'`,
  );
  await run(
    '6. q365_signals today:',
    `SELECT COUNT(*) AS n FROM q365_signals WHERE DATE(generated_at) = CURDATE()`,
  );
  await run(
    '7. q365_signal_explanations today:',
    `SELECT COUNT(*) AS n FROM q365_signal_explanations WHERE DATE(created_at) = CURDATE()`,
  );
  await run(
    '8. q365_strategy_breakdowns today:',
    `SELECT COUNT(*) AS n FROM q365_strategy_breakdowns WHERE DATE(created_at) = CURDATE()`,
  );

  console.log('\n─── Diagnostic: why scanned=0 in evaluateSignalOutcomes? ───\n');

  await run(
    'signals with populated entry/stop/target1 (any age):',
    `SELECT COUNT(*) AS n FROM q365_signals
       WHERE entry_price IS NOT NULL AND stop_loss IS NOT NULL AND target1 IS NOT NULL`,
  );
  await run(
    'signals in lookback window (last 180 days):',
    `SELECT COUNT(*) AS n FROM q365_signals
       WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 180 DAY)`,
  );
  await run(
    'signals old enough to grade (14+ days):',
    `SELECT COUNT(*) AS n FROM q365_signals
       WHERE generated_at <= DATE_SUB(NOW(), INTERVAL 14 DAY)`,
  );
  await run(
    'signals meeting full evaluateSignalOutcomes filter:',
    `SELECT COUNT(*) AS n FROM q365_signals
       WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 180 DAY)
         AND generated_at <= DATE_SUB(NOW(), INTERVAL 14 DAY)
         AND entry_price IS NOT NULL
         AND stop_loss   IS NOT NULL
         AND target1     IS NOT NULL`,
  );
  await run(
    'market_data_daily span:',
    `SELECT MIN(ts) AS first, MAX(ts) AS last, COUNT(*) AS n FROM market_data_daily`,
  );
  await run(
    'signal date range:',
    `SELECT MIN(generated_at) AS first, MAX(generated_at) AS last, COUNT(*) AS n FROM q365_signals`,
  );

  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
