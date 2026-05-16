import './loadEnv';
// ════════════════════════════════════════════════════════════════
//  Quantorus365 — Full Pipeline Exercise
//
//  Actually invokes the production code paths (no API HTTP calls):
//    1. generatePhase4Signals → persists signals + Phase 3 + Phase 4 memory
//    2. runBacktest      → produces signals/trades/audit
//    3. scanForManipulation → produces alerts
//
//  Then verifies that the audit tables now contain rows.
// ════════════════════════════════════════════════════════════════

import { db } from '../lib/db';

async function countRows(table: string): Promise<number> {
  try {
    const { rows } = await db.query<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM ${table}`);
    return Number((rows[0] as any)?.cnt ?? 0);
  } catch {
    return -1;
  }
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Full Pipeline Exercise');
  console.log('══════════════════════════════════════════════════\n');

  // ── Step 1: Signal pipeline ────────────────────────────
  console.log('▶ Running signal pipeline (limit=20)...');
  const beforeSignals = await countRows('q365_signals');
  const beforePhase3 = await countRows('q365_signal_trade_plans');
  const beforeMemory = await countRows('q365_decision_memory');

  try {
    const { generatePhase4Signals, DEFAULT_PHASE3_CONFIG } =
      await import('../lib/signal-engine');
    type EngineCandle = import('../lib/signal-engine').Candle;
    const candleProvider = {
      async fetchDailyCandles(symbol: string): Promise<EngineCandle[]> {
        const { rows } = await db.query(
          `SELECT ts, open, high, low, close, volume
             FROM market_data_daily
            WHERE symbol = ?
            ORDER BY ts ASC
            LIMIT 300`,
          [symbol],
        );
        return (rows as any[]).map((r) => ({
          ts: r.ts,
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: Number(r.volume),
        }));
      },
    };
    const portfolio = {
      capital: DEFAULT_PHASE3_CONFIG.defaultCapital,
      cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital,
      openPositions: [],
      pendingSignals: [],
    };
    const pipelineStart = Date.now();
    const result = await generatePhase4Signals(
      candleProvider,
      portfolio,
      undefined, undefined, undefined, undefined,
      { generationSource: 'test:runEnd2End' },
    );
    const approved = result.signals.filter(
      (s: any) => s.executionReadiness.approvalDecision === 'approved',
    ).length;
    console.log(`  ✓ Pipeline: scanned=${result.meta.scanned}, approved=${approved}, rejected=${result.meta.rejected + (result.signals.length - approved)}, duration=${Date.now() - pipelineStart}ms`);
  } catch (err) {
    console.log(`  ✗ Pipeline failed: ${(err as Error).message}`);
  }

  const afterSignals = await countRows('q365_signals');
  const afterPhase3 = await countRows('q365_signal_trade_plans');
  const afterMemory = await countRows('q365_decision_memory');

  console.log(`  Δ q365_signals:              ${beforeSignals} → ${afterSignals}  (${afterSignals - beforeSignals >= 0 ? '+' : ''}${afterSignals - beforeSignals})`);
  console.log(`  Δ q365_signal_trade_plans:   ${beforePhase3} → ${afterPhase3}  (${afterPhase3 - beforePhase3 >= 0 ? '+' : ''}${afterPhase3 - beforePhase3})`);
  console.log(`  Δ q365_decision_memory:      ${beforeMemory} → ${afterMemory}  (${afterMemory - beforeMemory >= 0 ? '+' : ''}${afterMemory - beforeMemory})`);

  // ── Step 2: Manipulation scan ──────────────────────────
  //
  // Post split-brain cleanup: this now drives the manipulation-engine
  // directly via scanSymbol + saveSnapshot, and measures rows landing
  // in q365_manipulation_events / q365_manipulation_snapshots (not the
  // deleted manipulation_alerts table).
  console.log('\n▶ Running manipulation scan (universe of 50)...');
  const beforeEvents = await countRows('q365_manipulation_events');
  const beforeSnaps = await countRows('q365_manipulation_snapshots');

  try {
    const { scanSymbol, saveSnapshot, ensureManipulationEngineTables } = await import('../lib/manipulation-engine');
    const { loadDailyBars } = await import('../lib/manipulation-engine/data/candleLoader');
    const { DEFAULT_PHASE1_CONFIG } = await import('../lib/signal-engine/constants/signalEngine.constants');
    await ensureManipulationEngineTables();

    let scanned = 0;
    let persisted = 0;
    const startMs = Date.now();
    for (const symbol of DEFAULT_PHASE1_CONFIG.universe) {
      const bars = await loadDailyBars(symbol, { lookback: 60 });
      if (bars.length < 22) continue;
      scanned++;
      const snap = scanSymbol(symbol, bars, { symbol });
      if (snap && snap.manipulationScore >= 30) {
        await saveSnapshot(snap);
        persisted++;
      }
    }
    console.log(`  ✓ Scan: scanned=${scanned}, persisted=${persisted}, duration=${Date.now() - startMs}ms`);
  } catch (err) {
    console.log(`  ✗ Scan failed: ${(err as Error).message}`);
  }

  const afterEvents = await countRows('q365_manipulation_events');
  const afterSnaps = await countRows('q365_manipulation_snapshots');
  console.log(`  Δ q365_manipulation_events:     ${beforeEvents} → ${afterEvents}  (${afterEvents - beforeEvents >= 0 ? '+' : ''}${afterEvents - beforeEvents})`);
  console.log(`  Δ q365_manipulation_snapshots:  ${beforeSnaps} → ${afterSnaps}  (${afterSnaps - beforeSnaps >= 0 ? '+' : ''}${afterSnaps - beforeSnaps})`);

  // ── Step 3: Backtest ───────────────────────────────────
  console.log('\n▶ Running backtest (1y range, 5 symbols)...');
  const beforeRuns = await countRows('backtest_runs');
  const beforeBtSignals = await countRows('backtest_signals');
  const beforeAudit = await countRows('backtest_audit_logs');

  try {
    const { runBacktest } = await import('../lib/backtesting/runner/backtestRunner');
    const { persistFullRun } = await import('../lib/backtesting/runner/runOrchestrator');
    const { DEFAULT_BACKTEST_CONFIG } = await import('../lib/backtesting/config/defaults');

    const config = {
      ...DEFAULT_BACKTEST_CONFIG,
      name: 'E2E Verification Run',
      universe: ['RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK'],
      startDate: '2025-01-01',
      endDate: '2025-12-31',
      warmupBars: 50,
    };

    const result = await runBacktest(config);
    console.log(`  ✓ Backtest: status=${result.status}, signals=${result.signalCount}, trades=${result.tradeCount}, duration=${result.durationMs}ms`);

    if (result.status === 'completed') {
      const orchestrated = await persistFullRun(result);
      const ps = orchestrated.persistenceSummary;
      console.log(`  ✓ Persisted: run=${ps.run} signals=${ps.signals} trades=${ps.trades} outcomes=${ps.signalOutcomes} metrics=${ps.metrics} calib=${ps.calibrationBuckets} equity=${ps.equityCurve} audit=${ps.auditEvents}`);
      if (ps.errors.length > 0) console.log(`    errors: ${ps.errors.join(' | ')}`);
    }
  } catch (err) {
    console.log(`  ✗ Backtest failed: ${(err as Error).message}`);
  }

  const afterRuns = await countRows('backtest_runs');
  const afterBtSignals = await countRows('backtest_signals');
  const afterAudit = await countRows('backtest_audit_logs');

  console.log(`  Δ backtest_runs:             ${beforeRuns} → ${afterRuns}`);
  console.log(`  Δ backtest_signals:          ${beforeBtSignals} → ${afterBtSignals}`);
  console.log(`  Δ backtest_audit_logs:       ${beforeAudit} → ${afterAudit}`);

  console.log('\n══════════════════════════════════════════════════\n');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
