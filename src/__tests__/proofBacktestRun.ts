// ════════════════════════════════════════════════════════════════
//  Backtest Run Proof Dump
//
//  Picks ONE backtest run (by run_id arg, or the most recently
//  completed) and prints every linked table, plus the
//  /api/backtests/:id response fetched via HTTP if a base URL is
//  provided.
//
//  Usage:
//    npx tsx src/__tests__/proofBacktestRun.ts
//    npx tsx src/__tests__/proofBacktestRun.ts <run_id>
//    API_BASE=http://localhost:3000 npx tsx src/__tests__/proofBacktestRun.ts
//
//  Nothing is fabricated. Empty tables print "NO ROWS".
// ════════════════════════════════════════════════════════════════

import './loadEnv';
import { db } from '../lib/db';

function hr(title: string) {
  console.log('\n─── ' + title + ' ' + '─'.repeat(Math.max(0, 62 - title.length)));
}

function fmt(v: any): string {
  if (v === null || v === undefined) return '·';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function kv(obj: Record<string, any>) {
  const width = Math.max(...Object.keys(obj).map((k) => k.length));
  for (const [k, v] of Object.entries(obj)) {
    console.log(`  ${k.padEnd(width)} : ${fmt(v)}`);
  }
}

function printRows(rows: any[], cols: string[]) {
  if (rows.length === 0) {
    console.log('  NO ROWS');
    return;
  }
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => fmt(r[c]).length)));
  const line = (cells: string[]) =>
    '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(line(widths.map((w) => '─'.repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => fmt(r[c]))));
}

async function count(table: string, runId: string): Promise<number> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM \`${table}\` WHERE run_id = ?`,
    [runId],
  );
  return Number((rows[0] as any).n);
}

(async () => {
  const arg = process.argv[2];
  let runId: string;

  if (arg) {
    runId = arg;
  } else {
    const { rows } = await db.query(
      `SELECT run_id FROM backtest_runs
        WHERE status = 'completed'
        ORDER BY COALESCE(completed_at, started_at) DESC
        LIMIT 1`,
      [],
    );
    if ((rows as any[]).length === 0) {
      // fallback: any run
      const { rows: any2 } = await db.query(
        `SELECT run_id FROM backtest_runs ORDER BY started_at DESC LIMIT 1`,
        [],
      );
      if ((any2 as any[]).length === 0) {
        console.error('backtest_runs is empty — nothing to prove.');
        process.exit(1);
      }
      runId = String((any2 as any[])[0].run_id);
    } else {
      runId = String((rows as any[])[0].run_id);
    }
  }

  console.log('══════════════════════════════════════════════════════════');
  console.log(` BACKTEST RUN PROOF — run_id = ${runId}`);
  console.log(` generated at ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════════════');

  // ── 1. backtest_runs ──────────────────────────────────────────
  hr('1. backtest_runs');
  const { rows: runRows } = await db.query(
    `SELECT id, run_id, name, status, started_at, completed_at, duration_ms,
            signal_count, trade_count, created_by, error,
            JSON_UNQUOTE(summary_json)  AS summary
       FROM backtest_runs WHERE run_id = ?`,
    [runId],
  );
  const run = (runRows as any[])[0];
  if (!run) {
    console.log('  NO ROW — run_id not found. Aborting.');
    process.exit(1);
  }
  kv(run);

  // ── 2. backtest_signals ───────────────────────────────────────
  hr('2. backtest_signals (first 10 of N)');
  const sigTotal = await count('backtest_signals', runId);
  console.log(`  total signals in run: ${sigTotal}`);
  const { rows: sigRows } = await db.query(
    `SELECT signal_id, symbol, date, strategy, regime, direction,
            confidence_score, status, bars_waited,
            entry_zone_low, entry_zone_high, stop_loss, target1,
            excluded_by_manipulation, manipulation_band
       FROM backtest_signals
      WHERE run_id = ?
      ORDER BY date ASC, id ASC
      LIMIT 10`,
    [runId],
  );
  printRows(sigRows as any[], [
    'signal_id', 'symbol', 'date', 'strategy', 'regime',
    'direction', 'confidence_score', 'status', 'bars_waited',
  ]);

  console.log('\n  Status distribution:');
  const { rows: statusRows } = await db.query(
    `SELECT status, COUNT(*) AS cnt
       FROM backtest_signals WHERE run_id = ?
      GROUP BY status ORDER BY cnt DESC`,
    [runId],
  );
  printRows(statusRows as any[], ['status', 'cnt']);

  // ── 3. backtest_trades ────────────────────────────────────────
  hr('3. backtest_trades (first 10)');
  const tradeTotal = await count('backtest_trades', runId);
  console.log(`  total trades in run: ${tradeTotal}`);
  const { rows: tradeRows } = await db.query(
    `SELECT trade_id, signal_id, symbol, strategy, direction,
            entry_date, exit_date, entry_price, exit_price,
            position_size, gross_pnl, net_pnl, return_pct, return_r,
            outcome, exit_reason, mfe_pct, mae_pct,
            target1_hit, target2_hit, stop_hit
       FROM backtest_trades
      WHERE run_id = ?
      ORDER BY entry_date ASC, id ASC
      LIMIT 10`,
    [runId],
  );
  printRows(tradeRows as any[], [
    'trade_id', 'signal_id', 'symbol', 'strategy',
    'entry_date', 'exit_date', 'entry_price', 'exit_price',
    'net_pnl', 'return_r', 'outcome', 'exit_reason',
  ]);

  // Cross-table sanity check: every trade.signal_id should map back to a backtest_signals row
  const { rows: orphanRows } = await db.query(
    `SELECT COUNT(*) AS n
       FROM backtest_trades t
       LEFT JOIN backtest_signals s
         ON s.run_id = t.run_id AND s.signal_id = t.signal_id
      WHERE t.run_id = ? AND s.id IS NULL`,
    [runId],
  );
  console.log(`\n  orphan trades (no matching signal row): ${(orphanRows[0] as any).n}`);

  // ── 4. backtest_signal_outcomes ───────────────────────────────
  hr('4. backtest_signal_outcomes (label distribution + sample)');
  const outcomeTotal = await count('backtest_signal_outcomes', runId);
  console.log(`  total outcomes: ${outcomeTotal}`);
  const { rows: outLabels } = await db.query(
    `SELECT outcome_label, COUNT(*) AS cnt
       FROM backtest_signal_outcomes WHERE run_id = ?
      GROUP BY outcome_label ORDER BY cnt DESC`,
    [runId],
  );
  printRows(outLabels as any[], ['outcome_label', 'cnt']);

  const { rows: outSample } = await db.query(
    `SELECT signal_id, trade_id, entry_triggered, bars_to_entry,
            target1_hit, target2_hit, target3_hit, stop_hit,
            max_fav_excursion_pct AS mfe, max_adv_excursion_pct AS mae,
            return_bar5_pct, return_bar10_pct, outcome_label
       FROM backtest_signal_outcomes
      WHERE run_id = ?
      ORDER BY id ASC LIMIT 5`,
    [runId],
  );
  console.log('\n  first 5 outcome rows:');
  printRows(outSample as any[], [
    'signal_id', 'trade_id', 'entry_triggered',
    'target1_hit', 'stop_hit', 'mfe', 'mae', 'outcome_label',
  ]);

  // ── 5. backtest_metrics ───────────────────────────────────────
  hr('5. backtest_metrics');
  const { rows: metricRows } = await db.query(
    `SELECT metric_key, metric_value, metric_unit, category, description
       FROM backtest_metrics WHERE run_id = ?
      ORDER BY category, metric_key`,
    [runId],
  );
  console.log(`  metric rows: ${(metricRows as any[]).length}`);
  printRows(metricRows as any[], ['category', 'metric_key', 'metric_value', 'metric_unit']);

  // ── 6. calibration_snapshots ──────────────────────────────────
  hr('6. calibration_snapshots');
  const { rows: calRows } = await db.query(
    `SELECT bucket, strategy, regime, sample_size,
            expected_hit_rate, actual_hit_rate,
            avg_mfe_pct, avg_mae_pct, calibration_state,
            modifier_suggestion, computed_at
       FROM calibration_snapshots WHERE run_id = ?
      ORDER BY bucket, strategy, regime`,
    [runId],
  );
  console.log(`  calibration rows: ${(calRows as any[]).length}`);
  printRows(calRows as any[], [
    'bucket', 'strategy', 'regime', 'sample_size',
    'expected_hit_rate', 'actual_hit_rate',
    'avg_mfe_pct', 'calibration_state', 'modifier_suggestion',
  ]);

  // ── 7. backtest_audit_logs ────────────────────────────────────
  hr('7. backtest_audit_logs');
  const auditTotal = await count('backtest_audit_logs', runId);
  console.log(`  total audit entries: ${auditTotal}`);
  const { rows: actionRows } = await db.query(
    `SELECT action, COUNT(*) AS cnt
       FROM backtest_audit_logs WHERE run_id = ?
      GROUP BY action ORDER BY cnt DESC`,
    [runId],
  );
  console.log('\n  action distribution:');
  printRows(actionRows as any[], ['action', 'cnt']);

  const { rows: firstAudit } = await db.query(
    `SELECT id, timestamp, bar_index, action, symbol, message
       FROM backtest_audit_logs WHERE run_id = ?
      ORDER BY id ASC LIMIT 5`,
    [runId],
  );
  const { rows: lastAudit } = await db.query(
    `SELECT id, timestamp, bar_index, action, symbol, message
       FROM backtest_audit_logs WHERE run_id = ?
      ORDER BY id DESC LIMIT 5`,
    [runId],
  );
  console.log('\n  first 5 audit entries:');
  printRows(firstAudit as any[], ['id', 'timestamp', 'bar_index', 'action', 'symbol', 'message']);
  console.log('\n  last 5 audit entries:');
  printRows((lastAudit as any[]).reverse(), ['id', 'timestamp', 'bar_index', 'action', 'symbol', 'message']);

  // ── Cross-table consistency ───────────────────────────────────
  hr('CONSISTENCY CHECKS');
  const checks = [
    { name: 'signal_count (runs) == rows (backtest_signals)',
      ok: Number(run.signal_count) === sigTotal,
      detail: `runs.signal_count=${run.signal_count} vs actual=${sigTotal}` },
    { name: 'trade_count (runs) == rows (backtest_trades)',
      ok: Number(run.trade_count) === tradeTotal,
      detail: `runs.trade_count=${run.trade_count} vs actual=${tradeTotal}` },
    { name: 'outcomes row count >= trades row count',
      ok: outcomeTotal >= tradeTotal,
      detail: `outcomes=${outcomeTotal} trades=${tradeTotal}` },
    { name: 'no orphan trades',
      ok: Number((orphanRows[0] as any).n) === 0,
      detail: `orphans=${(orphanRows[0] as any).n}` },
    { name: 'metrics populated',
      ok: (metricRows as any[]).length > 0,
      detail: `metric_rows=${(metricRows as any[]).length}` },
    { name: 'calibration populated',
      ok: (calRows as any[]).length > 0,
      detail: `cal_rows=${(calRows as any[]).length}` },
    { name: 'audit populated',
      ok: auditTotal > 0,
      detail: `audit_rows=${auditTotal}` },
  ];
  for (const c of checks) {
    console.log(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(50)} ${c.detail}`);
  }
  const allOk = checks.every((c) => c.ok);
  console.log(`\n  verdict: ${allOk ? 'ALL CHECKS PASS' : 'INCONSISTENCIES FOUND'}`);

  // ── API response ──────────────────────────────────────────────
  hr('API /api/backtests/:id (via HTTP)');
  const apiBase = process.env.API_BASE;
  if (!apiBase) {
    console.log('  skipped — set API_BASE=http://localhost:3000 to fetch');
  } else {
    try {
      const url = `${apiBase.replace(/\/$/, '')}/api/backtests/${encodeURIComponent(runId)}?include=metrics`;
      console.log(`  GET ${url}`);
      const res = await fetch(url);
      const body = await res.text();
      console.log(`  status: ${res.status}`);
      console.log(`  body (first 2000 chars):\n`);
      console.log(body.slice(0, 2000));
    } catch (e) {
      console.log(`  FETCH FAILED: ${(e as Error).message}`);
      console.log(`  (is the Next.js dev server running?)`);
    }
  }

  console.log('\n══════════════════════════════════════════════════════════');
  console.log(' END OF BACKTEST PROOF');
  console.log('══════════════════════════════════════════════════════════');
  process.exit(0);
})().catch((e) => {
  console.error('\nPROOF FAILED:', e);
  process.exit(1);
});
