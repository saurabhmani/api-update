import './loadEnv';
// ════════════════════════════════════════════════════════════════
//  Backtesting Phase 1 — Acceptance Test
//
//  Verifies the spec acceptance criteria:
//   - one successful run populates EVERY required backtest table
//   - signal rows are saved
//   - signal outcomes are saved
//   - run config is queryable
//   - signal_id ↔ trade_id linkage is intact
//   - failed runs still persist failure state
//
//  Run with:
//    DATABASE_URL="$YOUR_DB_URL" \
//      npx tsx src/__tests__/backtestingPhase1.test.ts
// ════════════════════════════════════════════════════════════════

import { db } from '../lib/db';
import { runBacktest } from '../lib/backtesting/runner/backtestRunner';
import { persistFullRun } from '../lib/backtesting/runner/runOrchestrator';
import { ensureBacktestTables } from '../lib/backtesting/repository/migrate';
import { DEFAULT_BACKTEST_CONFIG } from '../lib/backtesting/config/defaults';
import type { BacktestRunConfig } from '../lib/backtesting/types';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail: string) {
  checks.push({ name, passed, detail });
}

async function rowCountForRun(table: string, runId: string): Promise<number> {
  try {
    const { rows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM ${table} WHERE run_id = ?`,
      [runId],
    );
    return Number((rows[0] as any)?.c ?? 0);
  } catch {
    return -1;
  }
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Backtesting Phase 1 — Acceptance Test');
  console.log('══════════════════════════════════════════════════\n');

  await ensureBacktestTables();

  // ── Test 1: Successful run populates every table ──────────────
  console.log('▶ Test 1: Successful run truth chain');
  const successConfig: BacktestRunConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    name: 'Phase1 Acceptance — Success',
    universe: ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK'],
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    warmupBars: 50,
  };

  const successResult = await runBacktest(successConfig);
  check('runBacktest produces a result', successResult != null, `runId=${successResult.runId}`);
  check('Run completed (not failed)', successResult.status === 'completed', `status=${successResult.status}`);
  check('Result includes signals array', Array.isArray(successResult.signals), `${successResult.signals?.length ?? 0} signals`);
  check('Result includes trades array', Array.isArray(successResult.trades), `${successResult.trades?.length ?? 0} trades`);
  check('Result includes audit entries', Array.isArray(successResult.auditEntries), `${successResult.auditEntries?.length ?? 0} entries`);

  // Persist via orchestrator
  const orchestrated = await persistFullRun(successResult);
  const ps = orchestrated.persistenceSummary;
  console.log(`  persistence summary: run=${ps.run} signals=${ps.signals} trades=${ps.trades} outcomes=${ps.signalOutcomes} metrics=${ps.metrics} calib=${ps.calibrationBuckets} equity=${ps.equityCurve} audit=${ps.auditEvents}`);

  check('persistenceSummary.run >= 1', ps.run >= 1, `run=${ps.run}`);
  check('persistenceSummary.signals > 0', ps.signals > 0, `signals=${ps.signals}`);
  check('persistenceSummary.trades > 0', ps.trades > 0, `trades=${ps.trades}`);
  check('persistenceSummary.signalOutcomes > 0', ps.signalOutcomes > 0, `outcomes=${ps.signalOutcomes}`);
  check('persistenceSummary.metrics > 0', ps.metrics > 0, `metrics=${ps.metrics}`);
  check('persistenceSummary.equityCurve > 0', ps.equityCurve > 0, `equity=${ps.equityCurve}`);
  check('persistenceSummary.auditEvents > 0', ps.auditEvents > 0, `audit=${ps.auditEvents}`);
  check('persistenceSummary.errors empty', ps.errors.length === 0, ps.errors.join(' | ') || 'clean');

  // Verify every required table has rows for THIS run_id
  const runId = successResult.runId;
  for (const table of [
    'backtest_runs', 'backtest_signals', 'backtest_trades',
    'backtest_signal_outcomes', 'backtest_metrics',
    'backtest_equity_curve', 'backtest_audit_logs', 'calibration_snapshots',
  ]) {
    const cnt = await rowCountForRun(table, runId);
    check(`${table} has rows for run_id`, cnt > 0, `${cnt} rows`);
  }

  // Run config round-trips correctly
  const { rows: configRows } = await db.query(
    `SELECT config_json FROM backtest_runs WHERE run_id = ?`, [runId],
  );
  const persistedConfig = (configRows[0] as any)?.config_json;
  const parsed = typeof persistedConfig === 'string' ? JSON.parse(persistedConfig) : persistedConfig;
  check('Run config round-trips', parsed?.startDate === successConfig.startDate && parsed?.endDate === successConfig.endDate, `${parsed?.startDate} → ${parsed?.endDate}`);
  check('Run config preserves universe', Array.isArray(parsed?.universe) && parsed.universe.length === successConfig.universe.length, `${parsed?.universe?.length} symbols`);
  check('Run config preserves slippage assumption', parsed?.slippageBps === successConfig.slippageBps, `slippageBps=${parsed?.slippageBps}`);
  check('Run config preserves fill model', parsed?.fillModel === successConfig.fillModel, `fillModel=${parsed?.fillModel}`);
  check('Run config preserves warmupBars', parsed?.warmupBars === successConfig.warmupBars, `warmup=${parsed?.warmupBars}`);

  // Signal id ↔ trade id linkage
  const { rows: linkRows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c
     FROM backtest_trades t
     INNER JOIN backtest_signals s ON s.run_id = t.run_id AND s.signal_id = t.signal_id
     WHERE t.run_id = ?`,
    [runId],
  );
  const linked = Number((linkRows[0] as any)?.c ?? 0);
  check('signal_id ↔ trade_id linkage', linked > 0, `${linked} trades linked to signals`);

  // Signal IDs are unique within the run
  const { rows: dupRows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM (
       SELECT signal_id FROM backtest_signals WHERE run_id = ? GROUP BY signal_id HAVING COUNT(*) > 1
     ) dups`,
    [runId],
  );
  const dups = Number((dupRows[0] as any)?.c ?? 0);
  check('Signal IDs are unique within run', dups === 0, dups === 0 ? 'no duplicates' : `${dups} dupes`);

  // ── Test 2: Failed run still persists failure state ──────────
  console.log('\n▶ Test 2: Failed run persists failure state');
  const failConfig: BacktestRunConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    name: 'Phase1 Acceptance — Forced Failure',
    universe: ['DOES_NOT_EXIST_XYZ'],
    startDate: '2099-01-01',  // future date with no data
    endDate: '2099-12-31',
    warmupBars: 50,
  };

  const failResult = await runBacktest(failConfig);
  check('Failed run returns failed status', failResult.status === 'failed', `status=${failResult.status}, error=${failResult.error}`);
  check('Failed run has audit entries', failResult.auditEntries.length > 0, `${failResult.auditEntries.length} entries`);

  const failOrch = await persistFullRun(failResult);
  check('Failed run persistence does not throw', true, 'persistFullRun completed');
  check('Failed run record is saved', failOrch.persistenceSummary.run >= 1, `run=${failOrch.persistenceSummary.run}`);

  // Verify the failed run record exists in DB with status='failed'
  const { rows: failRows } = await db.query(
    `SELECT status, error FROM backtest_runs WHERE run_id = ?`, [failResult.runId],
  );
  const failRecord = failRows[0] as any;
  check('Failed run row exists in DB', failRecord != null, failRecord?.status ?? 'missing');
  check('Failed run status is "failed"', failRecord?.status === 'failed', `status=${failRecord?.status}`);
  check('Failed run preserves error message', failRecord?.error != null && failRecord.error.length > 0, `error="${failRecord?.error?.substring(0, 60)}"`);

  // ── Test 3: API endpoints return required fields ─────────────
  console.log('\n▶ Test 3: GET /api/backtests/:id query');
  const { loadBacktestRun } = await import('../lib/backtesting/repository/persistence');
  const loaded = await loadBacktestRun(runId);
  check('Run can be loaded by id', loaded != null, `loaded=${loaded != null}`);
  check('Loaded run has signal_count', loaded?.signal_count > 0, `signal_count=${loaded?.signal_count}`);
  check('Loaded run has trade_count', loaded?.trade_count > 0, `trade_count=${loaded?.trade_count}`);

  // ── Print results ─────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════\n');

  for (const c of checks) {
    const icon = c.passed ? '✅' : '❌';
    console.log(`  ${icon} ${c.name.padEnd(50)} ${c.detail}`);
  }

  const passed = checks.filter(c => c.passed).length;
  const failed = checks.length - passed;

  console.log(`\n  Total: ${checks.length}  |  Passed: ${passed}  |  Failed: ${failed}\n`);

  // Cleanup the failure test row to keep DB tidy
  try {
    await db.query(`DELETE FROM backtest_runs WHERE run_id = ?`, [failResult.runId]);
  } catch { /* ignore */ }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n❌ Test crashed:', err);
  process.exit(1);
});
