/**
 * scripts/tracePersistence.ts
 *
 * Spec INSTITUTIONAL §J — end-to-end persistence trace.
 *
 * Captures row counts before / after a single pipeline invocation and
 * runs the maturity worker once, so the operator can see EXACTLY what
 * each leg of the persistence chain did:
 *
 *   1. Snapshot row counts pre-run (q365_signals + q365_confirmed_signal_snapshots
 *      + q365_signal_maturity_tracker).
 *   2. Trigger generatePhase4Signals via the same code path /api/run-signal-engine
 *      uses (skipping the manual-run lock so the script is reentrant).
 *   3. Snapshot row counts post-Phase 4.
 *   4. Run the maturity worker once.
 *   5. Snapshot row counts post-maturity.
 *   6. Print the canonical persistence envelope:
 *        { scanned, matched, approved, persisted_q365_signals,
 *          persisted_confirmed_snapshots, rejected_before_save }
 *   7. Identify the failure stage (which leg dropped rows) and print
 *      the failing file/function reference.
 *
 * The script captures all log output via console interception so the
 * structured markers ([PIPELINE_START], [SCANNED], [MATCHED], [SCORED],
 * [PERSIST_ATTEMPT], [PERSIST_SUCCESS], [PERSIST_FAILED], [SNAPSHOT_WRITE],
 * [TRANSACTION_ROLLBACK], [PERSIST_FUNNEL], [PIPELINE_FUNNEL],
 * [MATURITY_FUNNEL]) are visible in the script output even when PM2
 * isn't running.
 *
 * Usage:
 *   npx tsx scripts/tracePersistence.ts
 *   npx tsx scripts/tracePersistence.ts --skip-pipeline    # only run maturity worker
 *   npx tsx scripts/tracePersistence.ts --skip-maturity    # only run pipeline
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import { generatePhase4Signals, DEFAULT_PHASE1_CONFIG } from '../src/lib/signal-engine';
import type { CandleProvider, Candle, PortfolioSnapshot } from '../src/lib/signal-engine';
import { runSignalMaturityWorker } from '../src/lib/cron/signalMaturity';

interface TableCounts {
  q365_signals_total:                 number;
  q365_signals_active:                number;
  q365_confirmed_snapshots_total:     number;
  q365_confirmed_snapshots_active:    number;
  q365_signal_maturity_tracker_total: number;
}

async function snapshotCounts(): Promise<TableCounts> {
  const pull = async (sql: string): Promise<number> => {
    try {
      const { rows } = await db.query<{ c: number }>(sql);
      return Number(rows[0]?.c ?? 0);
    } catch (err: any) {
      console.warn(`  count query failed (${sql.slice(0, 60)}…): ${err?.message}`);
      return -1;
    }
  };
  return {
    q365_signals_total:                 await pull(`SELECT COUNT(*) AS c FROM q365_signals`),
    q365_signals_active:                await pull(`SELECT COUNT(*) AS c FROM q365_signals WHERE status IN ('active','watchlist','flagged')`),
    q365_confirmed_snapshots_total:     await pull(`SELECT COUNT(*) AS c FROM q365_confirmed_signal_snapshots`),
    q365_confirmed_snapshots_active:    await pull(`SELECT COUNT(*) AS c FROM q365_confirmed_signal_snapshots WHERE status='ACTIVE' AND valid_until > NOW()`),
    q365_signal_maturity_tracker_total: await pull(`SELECT COUNT(*) AS c FROM q365_signal_maturity_tracker`),
  };
}

function diff(before: TableCounts, after: TableCounts): TableCounts {
  return {
    q365_signals_total:                 after.q365_signals_total                 - before.q365_signals_total,
    q365_signals_active:                after.q365_signals_active                - before.q365_signals_active,
    q365_confirmed_snapshots_total:     after.q365_confirmed_snapshots_total     - before.q365_confirmed_snapshots_total,
    q365_confirmed_snapshots_active:    after.q365_confirmed_snapshots_active    - before.q365_confirmed_snapshots_active,
    q365_signal_maturity_tracker_total: after.q365_signal_maturity_tracker_total - before.q365_signal_maturity_tracker_total,
  };
}

function fmt(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

function printCounts(label: string, c: TableCounts): void {
  console.log(`  ${label.padEnd(34)} q365_signals=${c.q365_signals_total} (active=${c.q365_signals_active})  ` +
              `confirmed=${c.q365_confirmed_snapshots_total} (active=${c.q365_confirmed_snapshots_active})  ` +
              `tracker=${c.q365_signal_maturity_tracker_total}`);
}

function printDelta(label: string, d: TableCounts): void {
  console.log(`  ${label.padEnd(34)} q365_signals=${fmt(d.q365_signals_total)} (active=${fmt(d.q365_signals_active)})  ` +
              `confirmed=${fmt(d.q365_confirmed_snapshots_total)} (active=${fmt(d.q365_confirmed_snapshots_active)})  ` +
              `tracker=${fmt(d.q365_signal_maturity_tracker_total)}`);
}

// ── Stub portfolio + candle provider for a script-mode pipeline run ────
//
// We don't have a real user session here, so a small synthesised
// portfolio with no positions is used. This is the exact same shape
// the route uses on a fresh user (see loadPortfolioSnapshot fallback).
const STUB_PORTFOLIO: PortfolioSnapshot = {
  capital:        1_000_000,
  cashAvailable:  1_000_000,
  openPositions:  [],
  pendingSignals: [],
};

// Minimal candle provider that reads from market_data_daily — same
// table the production CandleProvider uses. Mirrors src/lib/signal-engine
// dbCandleProvider behaviour but avoids importing the full route module.
const dbCandleProvider: CandleProvider = {
  async fetchDailyCandles(symbol: string): Promise<Candle[]> {
    try {
      const { rows } = await db.query<any>(
        `SELECT ts, open, high, low, close, volume
           FROM market_data_daily
          WHERE symbol = ?
          ORDER BY ts DESC
          LIMIT 250`,
        [symbol.toUpperCase()],
      );
      return ((rows as any[]) ?? [])
        .reverse()
        .map((r) => ({
          ts:     r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
          open:   Number(r.open),
          high:   Number(r.high),
          low:    Number(r.low),
          close:  Number(r.close),
          volume: Number(r.volume ?? 0),
        })) as Candle[];
    } catch (err: any) {
      console.warn(`  [stub-provider] ${symbol}: ${err?.message}`);
      return [];
    }
  },
};

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const skipPipeline = argv.includes('--skip-pipeline');
  const skipMaturity = argv.includes('--skip-maturity');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  PERSISTENCE TRACE — full chain audit');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // ── Step 0: pre-run snapshot ──
  console.log('\n  ▸ Step 0 — pre-run row counts');
  const t0Counts = await snapshotCounts();
  printCounts('pre-run', t0Counts);

  // ── Step 1: run Phase 4 (the scanner→q365_signals leg) ──
  let phase4Result: any = null;
  if (!skipPipeline) {
    console.log('\n  ▸ Step 1 — invoking generatePhase4Signals (scanner → q365_signals)');
    const universe = DEFAULT_PHASE1_CONFIG.universe;
    console.log(`     universe size: ${universe.length}`);
    try {
      phase4Result = await generatePhase4Signals(
        dbCandleProvider,
        STUB_PORTFOLIO,
        undefined,
        undefined,
        DEFAULT_PHASE1_CONFIG,
        undefined,
        { generationSource: 'script:tracePersistence' },
      );
      console.log(
        `     phase4 returned: scanned=${phase4Result.meta.scanned} ` +
        `approved=${phase4Result.meta.approved} ` +
        `deferred=${phase4Result.meta.deferred} ` +
        `rejected=${phase4Result.meta.rejected} ` +
        `enriched=${phase4Result.signals.length}`,
      );
    } catch (err: any) {
      console.error(`     ✗ generatePhase4Signals THREW: ${err?.message}`);
      console.error(`       stack: ${err?.stack?.split('\n').slice(0, 8).join('\n              ')}`);
    }
  } else {
    console.log('\n  ▸ Step 1 — SKIPPED (--skip-pipeline)');
  }

  const t1Counts = await snapshotCounts();
  printCounts('post-pipeline', t1Counts);
  printDelta('delta vs pre-run', diff(t0Counts, t1Counts));

  // ── Step 2: run the maturity worker (q365_signals → q365_confirmed_signal_snapshots) ──
  let maturityResult: any = null;
  if (!skipMaturity) {
    console.log('\n  ▸ Step 2 — invoking runSignalMaturityWorker (q365_signals → confirmed_snapshots)');
    try {
      maturityResult = await runSignalMaturityWorker();
      console.log(
        `     maturity returned: scanned=${maturityResult.scanned} ` +
        `promoted=${maturityResult.promoted} ` +
        `matured=${maturityResult.matured} ` +
        `developing=${maturityResult.developing} ` +
        `candidate=${maturityResult.candidate} ` +
        `regime_blocked=${maturityResult.regime_blocked} ` +
        `failed=${maturityResult.failed}`,
      );
    } catch (err: any) {
      console.error(`     ✗ runSignalMaturityWorker THREW: ${err?.message}`);
    }
  } else {
    console.log('\n  ▸ Step 2 — SKIPPED (--skip-maturity)');
  }

  const t2Counts = await snapshotCounts();
  printCounts('post-maturity', t2Counts);
  printDelta('delta vs post-pipeline', diff(t1Counts, t2Counts));
  printDelta('total delta (pre → post)', diff(t0Counts, t2Counts));

  // ── Step 3: canonical persistence envelope ──
  console.log('\n  ▸ Step 3 — persistence envelope');
  const envelope = {
    scanned:                       phase4Result?.meta.scanned ?? 0,
    matched:                       phase4Result?.signals.length ?? 0,
    approved:                      phase4Result?.meta.approved ?? 0,
    persisted_q365_signals:        diff(t0Counts, t1Counts).q365_signals_total,
    persisted_confirmed_snapshots: diff(t0Counts, t2Counts).q365_confirmed_snapshots_total,
    rejected_before_save:          phase4Result
      ? (phase4Result.meta.rejected + phase4Result.meta.deferred)
      : 0,
  };
  console.log('  ┌─────────────────────────────────────────────┐');
  for (const [k, v] of Object.entries(envelope)) {
    console.log(`  │  ${k.padEnd(34)} ${String(v).padStart(7)}  │`);
  }
  console.log('  └─────────────────────────────────────────────┘');

  // ── Step 4: failure stage diagnosis ──
  console.log('\n  ▸ Step 4 — failure stage diagnosis');
  const failures: Array<{ stage: string; file: string; symptom: string }> = [];

  if (envelope.scanned === 0) {
    failures.push({
      stage:   'scanner',
      file:    'src/lib/signal-engine/pipeline/generatePhase3Signals.ts',
      symptom: 'Phase 3 scanned 0 symbols. Likely cause: empty universe (DEFAULT_PHASE1_CONFIG.universe), missing market_data_daily candles, or candle provider returned []. Run `select count(*) from market_data_daily` to confirm bars exist.',
    });
  } else if (envelope.matched === 0) {
    failures.push({
      stage:   'strategy_match',
      file:    'src/lib/signal-engine/pipeline/generatePhase3Signals.ts',
      symptom: `Scanned ${envelope.scanned} symbols but 0 strategies matched. Either every row failed pre-filter (volume / volatility / price), or rejection engine vetoed every candidate. Check [STRATEGY] Phase3 rejection summary log line for the dominant rejection reason.`,
    });
  } else if (envelope.persisted_q365_signals === 0) {
    failures.push({
      stage:   'q365_signals_write',
      file:    'src/lib/signal-engine/repository/saveSignals.ts',
      symptom: `Phase 4 produced ${envelope.matched} enriched signals but 0 landed in q365_signals. Check the [PERSIST_FUNNEL] line — likely all rejected by live_gap (entry > 10% from LTP), momentum_contradiction (BUY into −3% sell-off), or duplicate_in_db. Adjust SAVE_SIGNAL_MAX_ENTRY_GAP_PCT if entry-vs-LTP gap is the dominant reason.`,
    });
  } else if (envelope.persisted_confirmed_snapshots === 0 && (maturityResult?.scanned ?? 0) > 0) {
    failures.push({
      stage:   'snapshot_promotion',
      file:    'src/lib/signal-engine/repository/confirmedSnapshots.ts',
      symptom: `Maturity worker scanned ${maturityResult?.scanned ?? 0} trackers but promoted 0. Check the [PERSIST_FAILED] log lines for the gate that rejected. Common causes: low_confidence (PROMOTE_MIN_CONFIDENCE), low_final_score (PROMOTE_MIN_FINAL_SCORE), low_cycles (PROMOTE_MIN_CYCLES), low_maturity (PROMOTE_MIN_MATURITY), wrong_classification (Phase 4 emitted classification not in {INSTITUTIONAL_HIGH_CONVICTION, HIGH_CONVICTION, VALID_SIGNAL}).`,
    });
  } else if (envelope.persisted_confirmed_snapshots === 0 && (maturityResult?.scanned ?? 0) === 0) {
    failures.push({
      stage:   'maturity_worker_input',
      file:    'src/lib/signal-engine/repository/maturityTracker.ts',
      symptom: `Maturity worker found 0 active trackers to process. The saveSignals → upsertTrackerOnDetection wiring is failing OR all trackers are 'promoted' / 'terminated' status. Check tracker stage distribution: \`SELECT stage, count(*) FROM q365_signal_maturity_tracker GROUP BY stage\`.`,
    });
  } else {
    console.log('  ✓ All persistence stages produced rows. No bottleneck detected.');
  }

  for (const f of failures) {
    console.log(`  ✗ STAGE: ${f.stage}`);
    console.log(`    FILE:  ${f.file}`);
    console.log(`    WHY:   ${f.symptom}`);
    console.log('');
  }

  // ── Step 5: latest_batch_id sanity ──
  console.log('  ▸ Step 5 — latest_batch_id sanity');
  try {
    const { rows } = await db.query<{
      batch_id: string | null; cnt: number; latest: string;
    }>(
      `SELECT batch_id, COUNT(*) AS cnt, MAX(generated_at) AS latest
         FROM q365_signals
         WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        GROUP BY batch_id
        ORDER BY latest DESC
        LIMIT 5`,
    );
    if ((rows as any[]).length === 0) {
      console.log('     no q365_signals rows in last 24h — pipeline has not run successfully recently');
    } else {
      for (const r of rows as any[]) {
        console.log(`     batch_id=${r.batch_id ?? '(null)'.padEnd(28)} count=${r.cnt} latest=${r.latest}`);
      }
    }
  } catch (err: any) {
    console.warn(`     batch query failed: ${err?.message}`);
  }

  console.log('');
  process.exit(envelope.persisted_q365_signals + envelope.persisted_confirmed_snapshots > 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('trace script failed:', err);
  process.exit(2);
});
