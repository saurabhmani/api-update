import './loadEnv';
import { db } from '../lib/db';

(async () => {
  const tables = [
    'backtest_runs',
    'backtest_signals',
    'backtest_trades',
    'backtest_signal_outcomes',
    'backtest_metrics',
    'backtest_performance_metrics',
    'backtest_equity_curve',
    'backtest_audit_logs',
  ];
  console.log('backtest table row counts:');
  for (const t of tables) {
    const { rows } = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
    console.log(` ${t}: ${(rows[0] as any).n}`);
  }

  // Any backtest run?
  const { rows: runs } = await db.query(
    `SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 1`,
  );
  console.log('\nlatest backtest run:', runs[0] ?? '(none)');

  process.exit(0);
})();
