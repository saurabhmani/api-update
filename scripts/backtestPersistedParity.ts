import fs from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { comparePersistedResults, PERSISTED_PARITY_TABLES, OPERATIONAL_PARITY_FIELDS } from '@/lib/backtesting/parity/persistedParity';
import { validateDeterministicBacktestFixture } from '@/lib/backtesting/parity/fixtureValidation';

const config = { host: process.env.BACKTEST_IT_DB_HOST ?? '127.0.0.1', port: Number(process.env.BACKTEST_IT_DB_PORT ?? 33316), user: process.env.BACKTEST_IT_DB_USER ?? 'backtest_it', password: process.env.BACKTEST_IT_DB_PASSWORD ?? 'integration-only', database: process.env.BACKTEST_IT_DB_NAME ?? 'quantorus_backtest_it' };
const runIds = { monolith: process.env.BACKTEST_PARITY_MONOLITH_RUN_ID ?? 'harness-monolith', worker: process.env.BACKTEST_PARITY_WORKER_RUN_ID ?? 'harness-service' };

async function main() {
  const pool = mysql.createPool({ ...config, connectionLimit: 2, dateStrings: true });
  try {
    const snapshots: Record<string, Record<string, unknown>> = { monolith: {}, worker: {} };
    for (const [processor, runId] of Object.entries(runIds)) {
      for (const table of PERSISTED_PARITY_TABLES) {
        const key = table === 'backtest_summary' ? 'backtest_id' : 'run_id';
        const orderBy: Record<string,string> = { backtest_trades:'signal_date,entry_date,symbol,trade_id',backtest_signals:'date,symbol,signal_id',backtest_signal_outcomes:'signal_id',backtest_metrics:'metric_key',calibration_snapshots:'bucket,strategy,regime',backtest_equity_curve:'date',backtest_news_analytics:'bucket' };
        const [rows]: any = await pool.query(`SELECT * FROM ${table} WHERE ${key}=? ORDER BY ${orderBy[table] ?? 'id'}`, [runId]);
        const replaceRunId = (value: unknown): unknown => Array.isArray(value) ? value.map(replaceRunId) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([name,item])=>[name,replaceRunId(item)])) : typeof value === 'string' ? value.replaceAll(runId,'$RUN_ID') : value;
        snapshots[processor][table] = replaceRunId(rows);
      }
    }
    const comparison = comparePersistedResults(snapshots.monolith, snapshots.worker);
    const fixture = await validateDeterministicBacktestFixture();
    const report = {
      executionStatus: comparison.verdict === 'equivalent' ? 'passed' : 'failed', verdict: comparison.verdict === 'equivalent' ? 'passed' : 'failed',
      fixtureId: fixture.fixtureId, fixtureVersion: fixture.fixtureVersion, fixtureContentHash: fixture.contentHash,
      monolithRunId: runIds.monolith, workerRunId: runIds.worker, comparedTables: comparison.comparedTables,
      normalization: [...OPERATIONAL_PARITY_FIELDS].sort(), rowCounts: Object.fromEntries(PERSISTED_PARITY_TABLES.map(table => [table, { monolith: (snapshots.monolith[table] as any[]).length, worker: (snapshots.worker[table] as any[]).length }])),
      mismatches: comparison.mismatches,
    };
    await fs.mkdir('artifacts', { recursive: true }); await fs.writeFile('artifacts/backtest-parity-report.json', JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2)); if (report.verdict !== 'passed') process.exitCode = 2;
  } finally { await pool.end(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
