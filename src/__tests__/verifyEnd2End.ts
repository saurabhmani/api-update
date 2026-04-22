import './loadEnv';
// ════════════════════════════════════════════════════════════════
//  Quantorus365 End-to-End Verification Script
//
//  Boots all required schemas, queries each table, and verifies
//  that the persistence flows from Phase 1 through Phase 4 are
//  populating the audit tables. Prints a coloured pass/fail report.
//
//  Run: npx tsx src/__tests__/verifyEnd2End.ts
// ════════════════════════════════════════════════════════════════

import { db } from '../lib/db';
import { ensureSignalEngineSchemas } from '../lib/signal-engine/repository/ensureSchemas';
import { ensureBacktestTables } from '../lib/backtesting/repository/migrate';
import { ensureManipulationEngineTables as ensureManipulationTables } from '../lib/manipulation-engine';

interface CheckResult {
  category: string;
  name: string;
  passed: boolean;
  detail: string;
}

const results: CheckResult[] = [];

function record(category: string, name: string, passed: boolean, detail: string) {
  results.push({ category, name, passed, detail });
}

async function tableExists(name: string): Promise<boolean> {
  try {
    await db.query(`SELECT 1 FROM ${name} LIMIT 1`);
    return true;
  } catch {
    return false;
  }
}

async function tableCount(name: string): Promise<number> {
  try {
    const { rows } = await db.query<{ cnt: number }>(`SELECT COUNT(*) AS cnt FROM ${name}`);
    return Number((rows[0] as any)?.cnt ?? 0);
  } catch {
    return -1;
  }
}

async function main() {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║  Quantorus365 — End-to-End Verification            ║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  // Step 1: Ensure all schemas exist
  console.log('▶ Ensuring schemas...');
  try {
    await ensureSignalEngineSchemas();
    record('Schema', 'Signal engine schemas (Phase 3+4)', true, 'ensured');
  } catch (err) {
    record('Schema', 'Signal engine schemas', false, (err as Error).message);
  }
  try {
    await ensureBacktestTables();
    record('Schema', 'Backtesting schemas', true, 'ensured');
  } catch (err) {
    record('Schema', 'Backtesting schemas', false, (err as Error).message);
  }
  try {
    await ensureManipulationTables();
    record('Schema', 'Manipulation detection schemas', true, 'ensured');
  } catch (err) {
    record('Schema', 'Manipulation detection schemas', false, (err as Error).message);
  }

  // Step 2: Verify all required tables exist
  console.log('▶ Verifying tables exist...');
  const requiredTables = [
    // Signal engine
    'q365_signals', 'q365_signal_reasons', 'q365_signal_feature_snapshots',
    // Phase 3
    'q365_signal_trade_plans', 'q365_signal_position_sizing',
    'q365_signal_portfolio_fit', 'q365_signal_execution_readiness',
    'q365_signal_lifecycle',
    // Phase 4
    'q365_signal_outcomes', 'q365_signal_explanations',
    'q365_decision_memory', 'q365_portfolio_commentary',
    // Backtesting
    'backtest_runs', 'backtest_signals', 'backtest_trades',
    'backtest_signal_outcomes', 'backtest_metrics',
    'backtest_equity_curve', 'backtest_audit_logs', 'calibration_snapshots',
    // Manipulation
    'manipulation_alerts',
    // Market data
    'candles',
  ];

  for (const t of requiredTables) {
    const exists = await tableExists(t);
    record('Table', t, exists, exists ? 'OK' : 'MISSING');
  }

  // Step 3: Population checks
  console.log('▶ Checking data population...');
  for (const t of requiredTables) {
    const count = await tableCount(t);
    if (count >= 0) {
      const populated = count > 0;
      record('Rows', t, populated, populated ? `${count} rows` : 'empty');
    }
  }

  // Step 4: Critical integrity checks
  console.log('▶ Running integrity checks...');

  // No signal_id=0 in audit tables
  try {
    const { rows: br } = await db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM q365_signal_explanations WHERE signal_id = 0`);
    const orphaned = Number((br[0] as any)?.cnt ?? 0);
    record('Integrity', 'No signal_id=0 in explanations', orphaned === 0, orphaned === 0 ? 'clean' : `${orphaned} orphaned rows`);
  } catch { record('Integrity', 'explanations check', false, 'query failed'); }

  // EOD candles available
  try {
    const { rows } = await db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM candles WHERE candle_type='eod' AND interval_unit='1day'`);
    const cnt = Number((rows[0] as any)?.cnt ?? 0);
    record('Integrity', 'EOD candle data', cnt > 0, `${cnt} candles`);
  } catch { record('Integrity', 'EOD data check', false, 'query failed'); }

  // Phase 4 functions importable
  try {
    const { saveDecisionMemory } = await import('../lib/signal-engine/repository/savePhase4Artifacts');
    record('Imports', 'saveDecisionMemory', typeof saveDecisionMemory === 'function', 'OK');
  } catch (err) { record('Imports', 'saveDecisionMemory', false, (err as Error).message); }

  try {
    const { savePhase3Artifacts } = await import('../lib/signal-engine/repository/savePhase3Signals');
    record('Imports', 'savePhase3Artifacts', typeof savePhase3Artifacts === 'function', 'OK');
  } catch (err) { record('Imports', 'savePhase3Artifacts', false, (err as Error).message); }

  try {
    const { fetchLiveNewsContext } = await import('../lib/signal-engine/context/macroContext');
    record('Imports', 'fetchLiveNewsContext', typeof fetchLiveNewsContext === 'function', 'OK');
  } catch (err) { record('Imports', 'fetchLiveNewsContext', false, (err as Error).message); }

  try {
    // Post-cleanup: the legacy manipulation-detection module has been
    // removed. The canonical scan entry point is scanSymbol in the
    // manipulation engine — verify it's wired up.
    const { scanSymbol } = await import('../lib/manipulation-engine');
    record('Imports', 'scanSymbol (engine)', typeof scanSymbol === 'function', 'OK');
  } catch (err) { record('Imports', 'scanSymbol (engine)', false, (err as Error).message); }

  // Print results grouped by category
  const categories = Array.from(new Set(results.map(r => r.category)));
  for (const cat of categories) {
    console.log(`\n── ${cat} ──`);
    for (const r of results.filter(x => x.category === cat)) {
      const icon = r.passed ? '✅' : '❌';
      console.log(`  ${icon} ${r.name.padEnd(45)} ${r.detail}`);
    }
  }

  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;

  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log(`║  Total: ${total}  |  Passed: ${passed}  |  Failed: ${failed}`.padEnd(53) + '║');
  console.log('╚════════════════════════════════════════════════════╝\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n❌ Verification crashed:', err);
  process.exit(1);
});
