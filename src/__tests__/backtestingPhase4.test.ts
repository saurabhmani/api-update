import './loadEnv';
// ════════════════════════════════════════════════════════════════
//  Backtesting Phase 4 — Orchestration + Audit + Status + UI Visibility
//
//  Verifies spec acceptance criteria:
//   - audit logs written during real runs (every phase boundary)
//   - run status transitions visible
//   - failed runs persist with error details + lastSuccessfulStep
//   - reproducibility: same config → same result
//   - no-lookahead validation
//   - list endpoint shows recent runs
//   - detail endpoint shows config + summary + counts
//   - failed run inspectable in DB and via API
//
//  Run: npm run test:phase4
// ════════════════════════════════════════════════════════════════

import { db } from '../lib/db';
import { runBacktest } from '../lib/backtesting/runner/backtestRunner';
import { persistFullRun } from '../lib/backtesting/runner/runOrchestrator';
import { ensureBacktestTables } from '../lib/backtesting/repository/migrate';
import { DEFAULT_BACKTEST_CONFIG } from '../lib/backtesting/config/defaults';
import { listBacktestRuns, loadBacktestRun } from '../lib/backtesting/repository/persistence';
import type { BacktestRunConfig, AuditAction } from '../lib/backtesting/types';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Backtesting Phase 4 — Orchestration + Audit + UI');
  console.log('══════════════════════════════════════════════════\n');

  await ensureBacktestTables();

  // ── Test 1: Audit log captures every phase boundary ──────
  console.log('▶ Test 1: Phase boundary audit events');
  const config: BacktestRunConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    name: 'Phase4 Acceptance',
    universe: ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK'],
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    warmupBars: 50,
  };

  const result = await runBacktest(config);
  check('Backtest completed', result.status === 'completed', `status=${result.status}`);

  const audit = result.auditEntries;
  const actions = new Set(audit.map(e => e.action));
  console.log(`  Captured ${audit.length} audit entries with ${actions.size} distinct actions: ${Array.from(actions).join(', ')}`);

  const requiredEvents: AuditAction[] = [
    'run_started',
    'config_validated',
    'data_loaded',
    'simulation_completed',
    'metrics_computed',
    'run_completed',
  ];
  for (const action of requiredEvents) {
    check(`Audit emits "${action}"`, actions.has(action), '');
  }

  // ── Test 2: Persist + verify audit events end up in DB ───
  console.log('\n▶ Test 2: Audit persistence');
  const orch = await persistFullRun(result);
  check('Persistence has zero errors', orch.persistenceSummary.errors.length === 0, orch.persistenceSummary.errors.join(' | ') || 'clean');
  check('persistenceSummary.auditEvents > 0', orch.persistenceSummary.auditEvents > 0, `${orch.persistenceSummary.auditEvents}`);

  // Verify rows landed in backtest_audit_logs
  const { rows: dbAuditRows } = await db.query<any>(
    `SELECT action, COUNT(*) as cnt FROM backtest_audit_logs WHERE run_id = ? GROUP BY action`,
    [result.runId],
  );
  const dbActions = new Set((dbAuditRows as any[]).map(r => r.action));
  check('DB has run_started event', dbActions.has('run_started'), '');
  check('DB has config_validated event', dbActions.has('config_validated'), '');
  check('DB has data_loaded event', dbActions.has('data_loaded'), '');
  check('DB has simulation_completed event', dbActions.has('simulation_completed'), '');
  check('DB has metrics_computed event', dbActions.has('metrics_computed'), '');
  check('DB has run_completed event', dbActions.has('run_completed'), '');

  // ── Test 3: Run status visible via list + detail endpoints
  console.log('\n▶ Test 3: Status visibility via list + detail');
  const allRuns = await listBacktestRuns();
  const ourRun = allRuns.find((r: any) => r.run_id === result.runId);
  check('Run appears in listBacktestRuns', !!ourRun, ourRun ? `status=${ourRun.status}` : 'not found');
  check('Listed run has correct status', ourRun?.status === 'completed', `${ourRun?.status}`);

  const detail = await loadBacktestRun(result.runId);
  check('Run loadable via loadBacktestRun', !!detail, '');
  check('Detail has trade_count', detail?.trade_count > 0, `trade_count=${detail?.trade_count}`);
  check('Detail has signal_count', detail?.signal_count > 0, `signal_count=${detail?.signal_count}`);
  check('Detail has config_json', !!detail?.config_json, '');

  // ── Test 4: Failed run persists with error + lastSuccessfulStep ──
  console.log('\n▶ Test 4: Failed run inspectable');
  const failConfig: BacktestRunConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    name: 'Phase4 Forced Failure',
    universe: ['NONEXISTENT_XYZ_SYMBOL'],
    startDate: '2099-01-01',
    endDate: '2099-12-31',
    warmupBars: 50,
  };

  const failResult = await runBacktest(failConfig);
  check('Failed run returns failed status', failResult.status === 'failed', `status=${failResult.status}`);
  check('Failed run has error message', !!failResult.error, `error=${failResult.error?.substring(0, 60)}`);
  check('Failed run has audit entries', failResult.auditEntries.length > 0, `${failResult.auditEntries.length} entries`);

  // Failed run audit must include run_started + config_validated + data_loaded
  const failActions = new Set(failResult.auditEntries.map(e => e.action));
  check('Failed run captured run_started before failure', failActions.has('run_started'), '');
  check('Failed run captured config_validated before failure', failActions.has('config_validated'), '');
  check('Failed run captured run_failed event', failActions.has('run_failed'), '');

  // Verify lastSuccessfulStep is in the run_failed payload
  const failEvent = failResult.auditEntries.find(e => e.action === 'run_failed');
  const lastStep = (failEvent?.payload as any)?.lastSuccessfulStep;
  check('Failed run records lastSuccessfulStep', !!lastStep, `lastSuccessfulStep=${lastStep}`);

  // Persist the failed run and verify DB state
  const failOrch = await persistFullRun(failResult);
  check('Failed run persists run record', failOrch.persistenceSummary.run >= 1, '');
  check('Failed run persists audit events', failOrch.persistenceSummary.auditEvents > 0, `${failOrch.persistenceSummary.auditEvents}`);

  const { rows: failRows } = await db.query<any>(
    `SELECT status, error FROM backtest_runs WHERE run_id = ?`,
    [failResult.runId],
  );
  const failRow = failRows[0];
  check('Failed run row in DB has status="failed"', failRow?.status === 'failed', `${failRow?.status}`);
  check('Failed run row preserves error message', !!failRow?.error, `${failRow?.error?.substring(0, 60)}`);

  // ── Test 5: Reproducibility (same config → same outcome) ─
  console.log('\n▶ Test 5: Reproducibility');
  const reproConfig: BacktestRunConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    name: 'Phase4 Reproducibility A',
    universe: ['RELIANCE', 'TCS', 'INFY'],
    startDate: '2024-08-01',  // start early so warmup is satisfied
    endDate: '2025-06-30',
    warmupBars: 50,  // validator requires >= 50 (EMA200 minimum)
  };

  const r1 = await runBacktest(reproConfig);
  const r2 = await runBacktest({ ...reproConfig, name: 'Phase4 Reproducibility B' });

  if (r1.status !== 'completed') console.log(`  Run A failed: ${r1.error}`);
  if (r2.status !== 'completed') console.log(`  Run B failed: ${r2.error}`);

  check('Run A completed', r1.status === 'completed', `${r1.status}${r1.error ? ' — ' + r1.error : ''}`);
  check('Run B completed', r2.status === 'completed', `${r2.status}${r2.error ? ' — ' + r2.error : ''}`);
  check('Same signal count', r1.signalCount === r2.signalCount, `${r1.signalCount} vs ${r2.signalCount}`);
  check('Same trade count', r1.tradeCount === r2.tradeCount, `${r1.tradeCount} vs ${r2.tradeCount}`);
  check('Same total return', Math.abs((r1.summary?.totalReturnPct ?? 0) - (r2.summary?.totalReturnPct ?? 0)) < 0.001,
    `${r1.summary?.totalReturnPct} vs ${r2.summary?.totalReturnPct}`);
  check('Same win rate', Math.abs((r1.summary?.winRate ?? 0) - (r2.summary?.winRate ?? 0)) < 0.001,
    `${r1.summary?.winRate} vs ${r2.summary?.winRate}`);
  check('Same final equity', Math.abs((r1.summary?.finalEquity ?? 0) - (r2.summary?.finalEquity ?? 0)) < 0.01,
    `${r1.summary?.finalEquity} vs ${r2.summary?.finalEquity}`);

  // ── Test 6: No-lookahead validation ──────────────────────
  console.log('\n▶ Test 6: No-lookahead validation');
  // Every signal's date must be <= the entry date of any trade derived from it,
  // AND every trade's exit_date must be >= its entry_date. If lookahead exists,
  // we'd see signals "predicting" past prices.
  const { rows: tradeRows } = await db.query<any>(
    `SELECT t.signal_id, t.signal_date, t.entry_date, t.exit_date,
            s.date as signal_creation_date
     FROM backtest_trades t
     LEFT JOIN backtest_signals s ON s.run_id = t.run_id AND s.signal_id = t.signal_id
     WHERE t.run_id = ?`,
    [result.runId],
  );

  let lookaheadViolations = 0;
  let dateOrderViolations = 0;
  for (const t of tradeRows as any[]) {
    if (t.signal_creation_date && t.entry_date) {
      // Entry must be on or after signal creation
      const sigDate = new Date(t.signal_creation_date).toISOString().split('T')[0];
      const entryDate = new Date(t.entry_date).toISOString().split('T')[0];
      if (entryDate < sigDate) lookaheadViolations++;
    }
    if (t.entry_date && t.exit_date) {
      const entry = new Date(t.entry_date).getTime();
      const exit = new Date(t.exit_date).getTime();
      if (exit < entry) dateOrderViolations++;
    }
  }
  check('No-lookahead: entry_date >= signal_date for all trades',
    lookaheadViolations === 0,
    lookaheadViolations === 0 ? `${tradeRows.length} trades clean` : `${lookaheadViolations} violations`);
  check('Date ordering: exit_date >= entry_date for all trades',
    dateOrderViolations === 0,
    `${tradeRows.length} trades`);

  // ── Test 7: API endpoint shape ───────────────────────────
  console.log('\n▶ Test 7: Run record shape from list endpoint');
  const listed = allRuns.find((r: any) => r.run_id === result.runId);
  if (listed) {
    check('Listed run has run_id', !!listed.run_id, '');
    check('Listed run has name', !!listed.name, '');
    check('Listed run has started_at', !!listed.started_at, '');
    check('Listed run has signal_count', listed.signal_count != null, `${listed.signal_count}`);
    check('Listed run has trade_count', listed.trade_count != null, `${listed.trade_count}`);
    check('Listed run has duration_ms', listed.duration_ms != null, `${listed.duration_ms}`);
  }

  // ── Cleanup the failure test row ─────────────────────────
  try {
    await db.query(`DELETE FROM backtest_audit_logs WHERE run_id = ?`, [failResult.runId]);
    await db.query(`DELETE FROM backtest_runs WHERE run_id = ?`, [failResult.runId]);
  } catch { /* ignore */ }

  // ── Print results ────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('══════════════════════════════════════════════════\n');

  for (const c of checks) {
    const icon = c.passed ? '✅' : '❌';
    console.log(`  ${icon} ${c.name.padEnd(58)} ${c.detail}`);
  }

  const passed = checks.filter(c => c.passed).length;
  const failed = checks.length - passed;
  console.log(`\n  Total: ${checks.length}  |  Passed: ${passed}  |  Failed: ${failed}\n`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n❌ Test crashed:', err);
  process.exit(1);
});
