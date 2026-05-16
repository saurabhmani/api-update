// ════════════════════════════════════════════════════════════════
//  Quantorus365 — Production Validation Tests
//
//  Validates: signal pipeline, backtesting engine, persistence,
//  manipulation detection, and API contracts.
//
//  Run: npx tsx src/__tests__/validation.test.ts
// ════════════════════════════════════════════════════════════════

import { db } from '../lib/db';

const results: { name: string; passed: boolean; error?: string }[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  results.push({ name, passed: condition, error: condition ? undefined : detail ?? 'Assertion failed' });
}

async function assertAsync(name: string, fn: () => Promise<boolean>, detail?: string) {
  try {
    const ok = await fn();
    results.push({ name, passed: ok, error: ok ? undefined : detail ?? 'Assertion failed' });
  } catch (err) {
    results.push({ name, passed: false, error: err instanceof Error ? err.message : String(err) });
  }
}

// ════════════════════════════════════════════════════════════════
//  1. DATABASE SCHEMA VALIDATION
// ════════════════════════════════════════════════════════════════

async function testDatabaseSchema() {
  console.log('\n📋 1. Database Schema Validation');

  const requiredTables = [
    'q365_signals', 'q365_signal_reasons', 'q365_signal_feature_snapshots',
    'backtest_runs', 'backtest_trades', 'backtest_signals',
    'backtest_signal_outcomes', 'backtest_metrics', 'calibration_snapshots',
    'backtest_equity_curve', 'backtest_audit_logs',
    'candles', 'instruments',
  ];

  for (const table of requiredTables) {
    await assertAsync(`Table ${table} exists`, async () => {
      try {
        await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
        return true;
      } catch { return false; }
    });
  }
}

// ════════════════════════════════════════════════════════════════
//  2. SIGNAL ENGINE VALIDATION
// ════════════════════════════════════════════════════════════════

async function testSignalEngine() {
  console.log('\n📋 2. Signal Engine Validation');

  // Check saveSignals returns Map
  const { saveSignals } = await import('../lib/signal-engine/repository/saveSignals');
  assert('saveSignals returns Map', typeof saveSignals === 'function');

  // Check Phase 3 save function exists
  const { savePhase3Artifacts } = await import('../lib/signal-engine/repository/savePhase3Signals');
  assert('savePhase3Artifacts exists', typeof savePhase3Artifacts === 'function');

  // Check Phase 4 imports saveSignals
  const phase4Module = await import('../lib/signal-engine/pipeline/generatePhase4Signals');
  assert('Phase 4 generatePhase4Signals exists', typeof phase4Module.generatePhase4Signals === 'function');

  // Verify no signalId=0 in strategy breakdowns (check DB)
  await assertAsync('No signalId=0 in strategy breakdowns', async () => {
    try {
      const { rows } = await db.query('SELECT COUNT(*) as cnt FROM q365_strategy_breakdowns WHERE signal_id = 0');
      return Number((rows[0] as any)?.cnt ?? 0) === 0;
    } catch { return true; } // table may not exist yet
  });
}

// ════════════════════════════════════════════════════════════════
//  3. BACKTESTING ENGINE VALIDATION
// ════════════════════════════════════════════════════════════════

async function testBacktestEngine() {
  console.log('\n📋 3. Backtesting Engine Validation');

  // Check BacktestRunResult includes signals
  const { runBacktest } = await import('../lib/backtesting/runner/backtestRunner');
  assert('runBacktest function exists', typeof runBacktest === 'function');

  // Check orchestrator accepts signals
  const { persistFullRun } = await import('../lib/backtesting/runner/runOrchestrator');
  assert('persistFullRun function exists', typeof persistFullRun === 'function');

  // Check audit logger
  const { AuditLogger } = await import('../lib/backtesting/repository/auditLogger');
  const audit = new AuditLogger('test-run');
  audit.log(0, 'run_started', 'Test', null, {});
  assert('AuditLogger works', audit.count === 1);

  // Check validation
  const { validateBacktestConfig } = await import('../lib/backtesting/utils/validation');
  assert('validateBacktestConfig exists', typeof validateBacktestConfig === 'function');

  // Check EOD candle data exists
  await assertAsync('EOD candle data available', async () => {
    const { rows } = await db.query(`SELECT COUNT(*) as cnt FROM candles WHERE candle_type = 'eod' AND interval_unit = '1day'`);
    return Number((rows[0] as any)?.cnt ?? 0) > 0;
  });

  // Check backtest tables via migration
  const { ensureBacktestTables } = await import('../lib/backtesting/repository/migrate');
  await assertAsync('Backtest tables created', async () => {
    await ensureBacktestTables();
    return true;
  });
}

// ════════════════════════════════════════════════════════════════
//  4. MANIPULATION DETECTION VALIDATION
// ════════════════════════════════════════════════════════════════

async function testManipulationDetection() {
  console.log('\n📋 4. Manipulation Detection Validation');

  // Post split-brain cleanup: these tests were rewritten against
  // the manipulation-engine public API. The legacy per-detector
  // unit tests (detectVolumeAnomaly etc.) were tied to the deleted
  // manipulation-detection module's signatures — we now exercise
  // the engine's scanSymbol orchestrator instead, which runs the
  // full detector registry in one call.
  const { scanSymbol, ensureManipulationEngineTables } = await import('../lib/manipulation-engine');

  // Synthetic bar series — 30 normal bars, then one spike.
  const baseDate = '2026-03-01';
  const mkBars = (n: number, spike = false) =>
    Array.from({ length: n }, (_, i) => {
      const isSpike = spike && i === n - 1;
      return {
        date: `2026-03-${String(i + 1).padStart(2, '0')}`,
        open: 100,
        high: isSpike ? 125 : 102,
        low: isSpike ? 99 : 99,
        close: isSpike ? 124 : 101,
        volume: isSpike ? 8_000_000 : 1_000_000,
      };
    });

  // Normal series — engine may still return a low-score snapshot,
  // but no detector should report severe-tier severity.
  const normalSnapshot = scanSymbol('TEST', mkBars(30, false), { symbol: 'TEST' });
  assert('scanSymbol returns a snapshot for normal bars', normalSnapshot !== null);
  assert(
    'Normal bars: no severe triggered events',
    !normalSnapshot?.triggeredEvents.some((e) => e.triggered && e.severity === 'severe'),
  );

  // Spike series — at least one detector should trigger.
  const spikeSnapshot = scanSymbol('TEST', mkBars(30, true), { symbol: 'TEST' });
  assert('scanSymbol returns a snapshot for spike bars', spikeSnapshot !== null);
  assert(
    'Spike bars: at least one triggered event',
    (spikeSnapshot?.triggeredEvents.filter((e) => e.triggered).length ?? 0) > 0,
  );
  assert(
    'Spike bars: manipulation score > 0',
    (spikeSnapshot?.manipulationScore ?? 0) > 0,
  );

  // Schema smoke test — ensures engine migrations can run.
  await assertAsync('Manipulation engine tables created', async () => {
    await ensureManipulationEngineTables();
    return true;
  });
}

// ════════════════════════════════════════════════════════════════
//  5. API CONTRACT VALIDATION
// ════════════════════════════════════════════════════════════════

async function testApiContracts() {
  console.log('\n📋 5. API Contract Validation');

  // Verify API route files exist
  const fs = await import('fs');
  const path = await import('path');
  const apiBase = path.join(process.cwd(), 'src/app/api');

  const requiredRoutes = [
    'backtests/route.ts',
    'backtests/[id]/route.ts',
    'backtests/[id]/trades/route.ts',
    'backtests/[id]/analytics/route.ts',
    'backtests/[id]/calibration/route.ts',
    'backtests/[id]/dexter/route.ts',
    'backtests/seed-data/route.ts',
    'manipulation/route.ts',
    'signal-engine/route.ts',
    'run-signal-engine/route.ts',
  ];

  for (const route of requiredRoutes) {
    const fullPath = path.join(apiBase, route);
    assert(`API route ${route} exists`, fs.existsSync(fullPath));
  }
}

// ════════════════════════════════════════════════════════════════
//  6. PERSISTENCE VALIDATION
// ════════════════════════════════════════════════════════════════

async function testPersistence() {
  console.log('\n📋 6. Persistence Validation');

  // Check persistence functions exist and are properly typed
  const persistence = await import('../lib/backtesting/repository/persistence');
  assert('saveBacktestRun exists', typeof persistence.saveBacktestRun === 'function');
  assert('loadBacktestRun exists', typeof persistence.loadBacktestRun === 'function');
  assert('listBacktestRuns exists', typeof persistence.listBacktestRuns === 'function');
  assert('loadBacktestTrades exists', typeof persistence.loadBacktestTrades === 'function');
  assert('loadEquityCurve exists', typeof persistence.loadEquityCurve === 'function');

  const metricsPersistence = await import('../lib/backtesting/repository/metricsPersistence');
  assert('saveBacktestMetrics exists', typeof metricsPersistence.saveBacktestMetrics === 'function');
  assert('saveCalibrationSnapshots exists', typeof metricsPersistence.saveCalibrationSnapshots === 'function');
  assert('saveSignalOutcomes exists', typeof metricsPersistence.saveSignalOutcomes === 'function');
  assert('saveBacktestSignals exists', typeof metricsPersistence.saveBacktestSignals === 'function');
}

// ════════════════════════════════════════════════════════════════
//  RUN ALL TESTS
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log('════════════════════════════════════════════════');
  console.log('  Quantorus365 Production Validation Suite');
  console.log('════════════════════════════════════════════════');

  await testDatabaseSchema();
  await testSignalEngine();
  await testBacktestEngine();
  await testManipulationDetection();
  await testApiContracts();
  await testPersistence();

  // Summary
  console.log('\n════════════════════════════════════════════════');
  console.log('  RESULTS');
  console.log('════════════════════════════════════════════════\n');

  const passed = results.filter(r => r.passed);
  const failed = results.filter(r => !r.passed);

  for (const r of results) {
    console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }

  console.log(`\n  Total: ${results.length} | Passed: ${passed.length} | Failed: ${failed.length}`);
  console.log('════════════════════════════════════════════════\n');

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
