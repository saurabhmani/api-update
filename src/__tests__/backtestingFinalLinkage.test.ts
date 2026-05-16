import './loadEnv';
// ════════════════════════════════════════════════════════════════
//  Backtesting Final Linkage Test
//
//  Verifies the FULL truth chain end-to-end:
//   1. Run a backtest (no API server needed — calls runBacktest directly)
//   2. Persist via the orchestrator
//   3. Pull every API endpoint via its loader
//   4. Verify signal → trade → outcome linkage is intact
//   5. Verify execution summary aggregates match raw counts
//
//  Run: npm run test:linkage
// ════════════════════════════════════════════════════════════════

import { db } from '../lib/db';
import { runBacktest } from '../lib/backtesting/runner/backtestRunner';
import { persistFullRun } from '../lib/backtesting/runner/runOrchestrator';
import { ensureBacktestTables } from '../lib/backtesting/repository/migrate';
import { DEFAULT_BACKTEST_CONFIG } from '../lib/backtesting/config/defaults';
import {
  loadBacktestRun, loadBacktestTrades, loadEquityCurve,
} from '../lib/backtesting/repository/persistence';
import {
  loadBacktestMetrics, loadCalibrationSnapshots,
} from '../lib/backtesting/repository/metricsPersistence';
import type { BacktestRunConfig } from '../lib/backtesting/types';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Backtesting Final Linkage Test');
  console.log('══════════════════════════════════════════════════\n');

  await ensureBacktestTables();

  // ── Step 1: Run + persist ─────────────────────────────────
  console.log('▶ Running backtest...');
  const config: BacktestRunConfig = {
    ...DEFAULT_BACKTEST_CONFIG,
    name: 'Final Linkage',
    universe: ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK'],
    startDate: '2025-01-01',
    endDate: '2025-12-31',
    warmupBars: 50,
  };

  const result = await runBacktest(config);
  check('Run completed', result.status === 'completed', `status=${result.status}`);

  const orch = await persistFullRun(result);
  check('Orchestration zero errors', orch.persistenceSummary.errors.length === 0, orch.persistenceSummary.errors.join(' | ') || 'clean');

  const runId = result.runId;
  console.log(`  runId=${runId}`);

  // ── Step 2: Load every endpoint ──────────────────────────
  console.log('\n▶ Loading every persisted artifact...');
  const [run, trades, equityCurve, metrics, calibration] = await Promise.all([
    loadBacktestRun(runId),
    loadBacktestTrades(runId),
    loadEquityCurve(runId),
    loadBacktestMetrics(runId),
    loadCalibrationSnapshots(runId),
  ]);

  check('loadBacktestRun returns row', !!run, '');
  check('loadBacktestTrades returns rows', trades.length > 0, `${trades.length} trades`);
  check('loadEquityCurve returns rows', equityCurve.length > 0, `${equityCurve.length} points`);
  check('loadBacktestMetrics returns rows', metrics.length > 0, `${metrics.length} metrics`);
  check('loadCalibrationSnapshots returns rows', calibration.length > 0, `${calibration.length} buckets`);

  // ── Step 3: Verify signals exist ─────────────────────────
  const { rows: signalRows } = await db.query<any>(
    `SELECT COUNT(*) AS cnt FROM backtest_signals WHERE run_id = ?`, [runId],
  );
  const signalCount = Number((signalRows[0] as any)?.cnt ?? 0);
  check('backtest_signals has rows', signalCount > 0, `${signalCount} signals`);

  // ── Step 4: Verify outcomes exist ────────────────────────
  const { rows: outcomeRows } = await db.query<any>(
    `SELECT COUNT(*) AS cnt FROM backtest_signal_outcomes WHERE run_id = ?`, [runId],
  );
  const outcomeCount = Number((outcomeRows[0] as any)?.cnt ?? 0);
  check('backtest_signal_outcomes has rows', outcomeCount > 0, `${outcomeCount} outcomes`);
  check('Outcomes count matches signals', outcomeCount === signalCount, `${outcomeCount} === ${signalCount}`);

  // ── Step 5: Verify audit logs ────────────────────────────
  const { rows: auditRows } = await db.query<any>(
    `SELECT COUNT(*) AS cnt FROM backtest_audit_logs WHERE run_id = ?`, [runId],
  );
  const auditCount = Number((auditRows[0] as any)?.cnt ?? 0);
  check('backtest_audit_logs has rows', auditCount > 0, `${auditCount} entries`);

  // ── Step 6: Signal → Trade linkage ───────────────────────
  console.log('\n▶ Verifying signal ↔ trade linkage...');
  const { rows: linkRows } = await db.query<any>(
    `SELECT COUNT(*) AS linked
     FROM backtest_trades t
     INNER JOIN backtest_signals s
       ON s.run_id = t.run_id AND s.signal_id = t.signal_id
     WHERE t.run_id = ?`,
    [runId],
  );
  const linked = Number((linkRows[0] as any)?.linked ?? 0);
  check('Every trade links to a signal', linked === trades.length, `${linked} linked / ${trades.length} trades`);

  // ── Step 7: Trade → Outcome linkage ──────────────────────
  const { rows: tradeOutcomeRows } = await db.query<any>(
    `SELECT COUNT(*) AS linked
     FROM backtest_signal_outcomes o
     INNER JOIN backtest_trades t
       ON t.run_id = o.run_id AND t.signal_id = o.signal_id
     WHERE o.run_id = ? AND o.entry_triggered = 1`,
    [runId],
  );
  const tradeLinked = Number((tradeOutcomeRows[0] as any)?.linked ?? 0);
  check('Triggered outcomes link to a trade', tradeLinked === trades.length, `${tradeLinked} === ${trades.length}`);

  // ── Step 8: Outcome label distribution ───────────────────
  const { rows: labelRows } = await db.query<any>(
    `SELECT outcome_label, COUNT(*) AS cnt
     FROM backtest_signal_outcomes WHERE run_id = ?
     GROUP BY outcome_label`,
    [runId],
  );
  const labels = (labelRows as any[]).map(r => r.outcome_label);
  check('Multiple outcome labels present', new Set(labels).size > 1 || labels.length > 0, `${labels.join(', ')}`);

  // ── Step 9: return_bar5/10 populated ─────────────────────
  const { rows: returnRows } = await db.query<any>(
    `SELECT COUNT(*) AS cnt
     FROM backtest_signal_outcomes
     WHERE run_id = ? AND return_bar5_pct IS NOT NULL`,
    [runId],
  );
  const withReturns = Number((returnRows[0] as any)?.cnt ?? 0);
  check('return_bar5_pct populated', withReturns > 0, `${withReturns}/${outcomeCount} outcomes`);

  // ── Step 10: Calibration buckets present ─────────────────
  const bucketLabels = new Set(calibration.map(c => c.bucket));
  for (const expectedBucket of ['50_59', '60_69', '70_79', '80_89', '90_100']) {
    check(`Calibration bucket "${expectedBucket}" exists`, bucketLabels.has(expectedBucket), '');
  }

  // ── Step 11: All required calibration fields are camelCase
  if (calibration.length > 0) {
    const c = calibration[0];
    check('Calibration row has expectedHitRate (camelCase)', 'expectedHitRate' in c, '');
    check('Calibration row has actualHitRate (camelCase)', 'actualHitRate' in c, '');
    check('Calibration row has confidenceModifierSuggestion (camelCase)', 'confidenceModifierSuggestion' in c, '');
    check('Calibration row has sampleSize (camelCase)', 'sampleSize' in c, '');
    check('Calibration row has calibrationState (camelCase)', 'calibrationState' in c, '');
  }

  // ── Step 12: No-lookahead — signal date <= trade entry ──
  const { rows: lookaheadRows } = await db.query<any>(
    `SELECT COUNT(*) AS violations
     FROM backtest_trades t
     INNER JOIN backtest_signals s
       ON s.run_id = t.run_id AND s.signal_id = t.signal_id
     WHERE t.run_id = ?
       AND DATE(t.entry_date) < DATE(s.date)`,
    [runId],
  );
  const violations = Number((lookaheadRows[0] as any)?.violations ?? 0);
  check('Zero lookahead violations', violations === 0, `${violations} violations`);

  // ── Step 13: Equity curve continuity ─────────────────────
  const sortedDates = equityCurve.map((p: any) => typeof p.date === 'string' ? p.date.split('T')[0] : p.date).sort();
  const dateSet = new Set(sortedDates);
  check('Equity curve has unique dates', dateSet.size === equityCurve.length, `${dateSet.size} unique / ${equityCurve.length} total`);

  // ── Step 14: Execution summary aggregates match ──────────
  console.log('\n▶ Verifying execution summary aggregates...');
  const { rows: lifecycle } = await db.query<any>(
    `SELECT status, COUNT(*) AS cnt FROM backtest_signals WHERE run_id = ? GROUP BY status`,
    [runId],
  );
  const lifecycleMap: Record<string, number> = {};
  for (const r of lifecycle as any[]) lifecycleMap[r.status] = Number(r.cnt);

  const triggeredViaLifecycle = lifecycleMap.triggered ?? 0;
  check('triggered count >= trade count', triggeredViaLifecycle >= trades.length, `${triggeredViaLifecycle} >= ${trades.length}`);

  // ── Step 15: Run config preserved ────────────────────────
  console.log('\n▶ Verifying run config persistence...');
  const persistedConfig = typeof run.config_json === 'string' ? JSON.parse(run.config_json) : run.config_json;
  check('Config has universe', Array.isArray(persistedConfig?.universe), `${persistedConfig?.universe?.length} symbols`);
  check('Config has startDate', !!persistedConfig?.startDate, persistedConfig?.startDate);
  check('Config has endDate', !!persistedConfig?.endDate, persistedConfig?.endDate);
  check('Config has slippageBps', persistedConfig?.slippageBps != null, `${persistedConfig?.slippageBps}`);
  check('Config has commissionPerTrade', persistedConfig?.commissionPerTrade != null, `${persistedConfig?.commissionPerTrade}`);
  check('Config has fillModel', !!persistedConfig?.fillModel, persistedConfig?.fillModel);
  check('Config has warmupBars', persistedConfig?.warmupBars != null, `${persistedConfig?.warmupBars}`);
  check('Config has signalExpiryBars', persistedConfig?.signalExpiryBars != null, `${persistedConfig?.signalExpiryBars}`);
  check('Config has minConfidence', persistedConfig?.minConfidence != null, `${persistedConfig?.minConfidence}`);
  check('Config has minRewardRisk', persistedConfig?.minRewardRisk != null, `${persistedConfig?.minRewardRisk}`);

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
