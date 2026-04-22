import './loadEnv';
import { db } from '../lib/db';

(async () => {
  const tables = [
    'q365_signals',
    'q365_signal_reasons',
    'q365_signal_feature_snapshots',
    'q365_signal_trade_plans',
    'q365_signal_position_sizing',
    'q365_signal_portfolio_fit',
    'q365_signal_lifecycle',
    'q365_signal_outcomes',
    'q365_signal_explanations',
    'q365_decision_memory',
    'q365_strategy_breakdowns',
    'q365_confidence_calibration',
    'q365_strategy_performance_snapshots',
    'q365_adaptive_recommendations',
    'q365_learning_job_runs',
    'q365_manipulation_snapshots',
    'q365_manipulation_events',
    'q365_manipulation_detector_results',
    'q365_manipulation_watchlist',
    'backtest_runs',
    'backtest_signals',
    'backtest_trades',
    'backtest_signal_outcomes',
    'backtest_metrics',
    'calibration_snapshots',
    'backtest_audit_logs',
    'market_data_daily',
    'signals',
  ];
  console.log('table                                   |    total |    today');
  console.log('----------------------------------------|----------|---------');
  for (const t of tables) {
    try {
      const { rows: ex } = await db.query(
        `SELECT COUNT(*) AS n FROM information_schema.tables
          WHERE table_schema = DATABASE() AND table_name = ?`,
        [t],
      );
      if (Number((ex[0] as any).n) === 0) {
        console.log(`${t.padEnd(40)} |  MISSING |  MISSING`);
        continue;
      }
      const { rows: tot } = await db.query(`SELECT COUNT(*) AS n FROM \`${t}\``);
      const total = Number((tot[0] as any).n);

      const { rows: cols } = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ?`,
        [t],
      );
      const set = new Set((cols as any[]).map((r) => String(r.column_name || r.COLUMN_NAME).toLowerCase()));
      const tsCol = ['created_at', 'evaluated_at', 'computed_at', 'generated_at', 'run_at', 'started_at', 'ts']
        .find((c) => set.has(c));
      let today = '—';
      if (tsCol) {
        const { rows: td } = await db.query(
          `SELECT COUNT(*) AS n FROM \`${t}\` WHERE DATE(\`${tsCol}\`) = CURDATE()`,
        );
        today = String((td[0] as any).n);
      }
      console.log(`${t.padEnd(40)} | ${String(total).padStart(8)} | ${String(today).padStart(8)}`);
    } catch (e) {
      console.log(`${t.padEnd(40)} |    ERROR | ${(e as Error).message.slice(0, 40)}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
