// One-shot DB proof dumper — prints row counts and latest samples across
// every table the acceptance doc asks about. Run with:
//   npx tsx src/__tests__/proofDump.ts
import 'tsconfig-paths/register';
import * as fs from 'fs';
import * as path from 'path';
try {
  const envFile = fs.readFileSync(path.resolve(process.cwd(), '.env.local'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch {}

import { db } from '@/lib/db';

const TABLES = [
  'q365_signals',
  'q365_signal_outcomes',
  'q365_signal_feature_snapshots',
  'q365_signal_reasons',
  'q365_signal_trade_plans',
  'q365_signal_position_sizing',
  'q365_signal_portfolio_fit',
  'q365_signal_execution_readiness',
  'q365_signal_risk_snapshots',
  'q365_signal_lifecycle',
  'q365_signal_explanations',
  'q365_decision_memory',
  'q365_strategy_breakdowns',
  'q365_confidence_calibration',
  'q365_strategy_performance_snapshots',
  'q365_adaptive_recommendations',
  'q365_manipulation_snapshots',
  'q365_manipulation_events',
  'q365_manipulation_detector_results',
  'q365_manipulation_penalties',
  'q365_manipulation_watchlists',
  'q365_manipulation_watchlist_history',
  'q365_manipulation_calibration_snapshots',
  'q365_learning_job_runs',
  'backtest_runs',
  'backtest_signals',
  'backtest_trades',
  'backtest_signal_outcomes',
  'backtest_metrics',
  'backtest_audit_logs',
];

async function main() {
  console.log('='.repeat(60));
  console.log('  PROOF DUMP — q365 persistence');
  console.log('='.repeat(60));

  for (const t of TABLES) {
    try {
      const { rows } = await db.query(`SELECT COUNT(*) AS c FROM ${t}`);
      const c = Number((rows[0] as any).c);
      console.log(`${t.padEnd(44)} ${String(c).padStart(8)}`);
    } catch (err) {
      console.log(`${t.padEnd(44)} ${'MISSING'.padStart(8)} — ${(err as Error).message.slice(0, 60)}`);
    }
  }

  // Latest signal with full linkage
  console.log('\n' + '='.repeat(60));
  console.log('  LATEST q365_signals ROW');
  console.log('='.repeat(60));
  // Schema-adaptive: SELECT * so we always succeed regardless of drift.
  const { rows: latestSig } = await db.query(
    `SELECT * FROM q365_signals ORDER BY id DESC LIMIT 1`,
  );
  console.log(JSON.stringify(latestSig[0] ?? null, null, 2));

  if (latestSig[0]) {
    const sid = (latestSig[0] as any).id;
    const linkTables: [string, string][] = [
      ['q365_signal_outcomes',          'signal_id'],
      ['q365_signal_feature_snapshots', 'signal_id'],
      ['q365_signal_reasons',           'signal_id'],
      ['q365_signal_trade_plans',       'signal_id'],
      ['q365_signal_position_sizing',   'signal_id'],
      ['q365_signal_portfolio_fit',     'signal_id'],
      ['q365_signal_execution_readiness','signal_id'],
      ['q365_signal_risk_snapshots',    'signal_id'],
      ['q365_signal_lifecycle',         'signal_id'],
      ['q365_signal_explanations',      'signal_id'],
      ['q365_decision_memory',          'signal_id'],
      ['q365_strategy_breakdowns',      'signal_id'],
    ];
    console.log(`\n  Linkage for signal_id=${sid}:`);
    for (const [tbl, col] of linkTables) {
      try {
        const { rows } = await db.query(`SELECT COUNT(*) AS c FROM ${tbl} WHERE ${col}=?`, [sid]);
        console.log(`    ${tbl.padEnd(40)} ${String(Number((rows[0] as any).c)).padStart(4)}`);
      } catch (err) {
        console.log(`    ${tbl.padEnd(40)} MISSING`);
      }
    }
  }

  // Recent learning-job run log
  console.log('\n' + '='.repeat(60));
  console.log('  q365_learning_job_runs (last 10)');
  console.log('='.repeat(60));
  try {
    const { rows } = await db.query(
      `SELECT job_name, status, duration_ms, counts_json, run_at
         FROM q365_learning_job_runs
        ORDER BY id DESC LIMIT 10`,
    );
    for (const r of rows as any[]) {
      console.log(`  ${r.run_at}  ${String(r.job_name).padEnd(40)} ${r.status.padEnd(8)} ${r.duration_ms}ms`);
      if (r.counts_json) console.log(`    counts: ${r.counts_json}`);
    }
  } catch (err) {
    console.log('  (table missing or unreadable): ' + (err as Error).message);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
