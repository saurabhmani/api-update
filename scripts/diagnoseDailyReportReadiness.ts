import { config as loadEnv } from 'dotenv';
import { resolveEnvFilePath } from '../src/lib/envPath';
loadEnv({ path: resolveEnvFilePath() });

import { db } from '../src/lib/db';

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query<any>(
    `SELECT COUNT(*) AS c FROM information_schema.tables
      WHERE table_schema=DATABASE() AND table_name=?`, [name],
  );
  return Number(rows[0]?.c ?? 0) > 0;
}

async function main() {
  const reportTable = await tableExists('q365_daily_signal_reports');
  const maintenanceTable = await tableExists('q365_maintenance_job_runs');
  const { rows: clockRows } = await db.query<any>(
    `SELECT NOW() AS database_now, @@session.time_zone AS session_timezone,
            (SELECT COUNT(*) FROM q365_universe WHERE is_active=1) AS active_universe`,
  );
  const { rows: scoreRows } = await db.query<any>(
    `SELECT COUNT(*) AS active,
            SUM(CASE WHEN COALESCE(composite_final_score, final_score) IS NOT NULL THEN 1 ELSE 0 END) AS scored,
            SUM(CASE WHEN COALESCE(phase4_factor_scores_json, factor_scores_json) IS NOT NULL THEN 1 ELSE 0 END) AS factored,
            MAX(generated_at) AS latest
       FROM q365_signals WHERE status='active'`,
  );
  const { rows: candleRows } = await db.query<any>(
    `SELECT MAX(DATE(ts)) AS latest_date, COUNT(DISTINCT instrument_key) AS symbols
       FROM candles WHERE candle_type='eod' AND interval_unit='1day'
        AND DATE(ts)=(SELECT MAX(DATE(ts)) FROM candles WHERE candle_type='eod' AND interval_unit='1day')`,
  );
  const { rows: manipulationRows } = await db.query<any>(
    `SELECT MAX(snapshot_date) AS latest_date, COUNT(DISTINCT symbol) AS symbols
       FROM q365_manipulation_snapshots
      WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM q365_manipulation_snapshots)`,
  ).catch((error) => ({ rows: [{ error: error instanceof Error ? error.message : String(error) }] }));
  const reports = reportTable
    ? (await db.query<any>(`SELECT report_date, report_status, data_status, generated_at
          FROM q365_daily_signal_reports ORDER BY report_date DESC LIMIT 3`)).rows
    : [];
  const jobs = maintenanceTable
    ? (await db.query<any>(`SELECT trading_date, job_name, status, retry_count, last_error, completed_at
          FROM q365_maintenance_job_runs ORDER BY trading_date DESC, id DESC LIMIT 20`)).rows
    : [];
  console.log(JSON.stringify({
    database: { reportTable, maintenanceTable },
    runtime: clockRows[0] ?? {},
    signals: scoreRows[0] ?? {},
    candles: candleRows[0] ?? {},
    manipulation: manipulationRows[0] ?? {},
    latestReports: reports,
    latestMaintenanceJobs: jobs,
    config: {
      maintenanceEnabled: process.env.DAILY_MAINTENANCE_PIPELINE_ENABLED !== 'false',
      maintenanceCron: process.env.DAILY_MAINTENANCE_CRON ?? '30 20 * * 1-5',
    },
  }, null, 2));
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
