/**
 * Quantorus365 — Worker-process scheduler entrypoint
 *
 * Architecture freeze (Priority 1B):
 *   Market-data refresh runs on the canonical cadence in
 *   `src/lib/scheduler.ts` (IST):
 *     09:20 IST  — pre-open warmup
 *     09:30 → 15:30 IST @ 10m — intraday refresh loop
 *     15:35 IST  — post-close reconciliation
 *   Every pass goes through `MarketDataProvider` (IndianAPI → cache
 *   → Yahoo → PostgreSQL) and writes one structured run log. // @deprecated marker
 *
 *   This file is the worker-process boot wrapper that `npm run
 *   scheduler` (and PM2) invoke. It bootstraps env + path aliases,
 *   starts the canonical market-data scheduler, and registers the
 *   non-market-data nightly jobs that used to live here:
 *     18:30 IST — signal generation (Phase-4)
 *     19:00 IST — nightly backtest
 *     00:00 IST — midnight maintenance
 *
 * Jobs REMOVED from this file during the Priority 1B cutover
 * (now served by `startScheduler()` in `src/lib/scheduler.ts`):
 *     06:00 IST — pre-market warmup         (superseded by 09:20 IST)
 *     09:30 IST — market-open batch snapshot (superseded by 10-min loop)
 *     12:30 IST — midday refresh             (superseded by 10-min loop)
 *     17:45 IST — Yahoo daily backfill       (Yahoo is fallback-only now) // @deprecated marker
 *     18:00 IST — EOD snapshot               (superseded by 15:35 post-close)
 *
 * Start:  npx ts-node src/lib/workers/scheduler.ts
 * PM2:    pm2 start src/lib/workers/scheduler.ts --name quantorus365-scheduler
 */

// ── Load .env.local in non-production only (PM2/System provides prod env) ─
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
if (process.env.NODE_ENV !== 'production') {
  dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });
}

// ── Bootstrap path aliases (ts-node doesn't support @/ by default) ─
import 'tsconfig-paths/register';

import cron from 'node-cron';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { startScheduler as startMarketDataScheduler } from '@/lib/scheduler';
import {
  generatePhase4Signals,
  DEFAULT_PHASE3_CONFIG,
  type CandleProvider,
  type Candle,
  type PortfolioSnapshot,
} from '@/lib/signal-engine';
import {
  runBacktest,
  persistFullRun,
  DEFAULT_BACKTEST_CONFIG,
} from '@/lib/backtesting';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';
import { processQueuedBacktestRuns } from '@/lib/backtesting/runner/backtestQueue';
import { rescoreActiveSignals } from '@/lib/signal-engine/rescore/rescoreActiveSignals';

const log = logger.child({ component: 'worker-scheduler' });
const IST = 'Asia/Kolkata';

// ── Nightly signal generation ────────────────────────────────────
// Reads daily candles from the persisted warehouse and runs the
// Phase-4 pipeline. The daily-candle query below is one of the
// remaining `@/lib/db` call sites tracked in `MIGRATION_PLAYBOOK.md`
// Tier 6 — it will move to the PostgreSQL-native repo when that tier
// is migrated. The market-data ingestion that populates those
// candles runs through `startMarketDataScheduler()` above.

const signalCandleProvider: CandleProvider = {
  async fetchDailyCandles(symbol: string): Promise<Candle[]> {
    const result = await db.query(
      `SELECT ts, open, high, low, close, volume FROM (
         SELECT ts, open, high, low, close, volume
           FROM market_data_daily
          WHERE symbol = ?
          ORDER BY ts DESC
          LIMIT 300
       ) t
       ORDER BY ts ASC`,
      [symbol],
    );
    return (result.rows as any[]).map((r) => ({
      ts:     r.ts,
      open:   Number(r.open),
      high:   Number(r.high),
      low:    Number(r.low),
      close:  Number(r.close),
      volume: Number(r.volume),
    }));
  },
};

// In-flight guard: at a 10-min regen cadence a slow Yahoo fallback // @deprecated marker
// or DB contention can stretch a single run past the interval. The
// next tick must skip — NOT queue — to avoid stacking generations
// and thrashing the q365_signals write path. The guard returns the
// existing promise so callers always await the live run.
let signalGenInFlight: Promise<void> | null = null;

async function runSignalGeneration(): Promise<void> {
  if (signalGenInFlight) {
    log.warn('[REGEN] previous run still in flight — skipping this tick');
    return signalGenInFlight;
  }
  signalGenInFlight = (async () => {
    const started = Date.now();
    // Spec FULL-SCAN-2026-05 — canonical [FULL_SCAN_*] tags so the
    // operator can grep one tag family and see the deep institutional
    // scan separately from the lightweight heartbeat tier
    // ([SCAN_COVERAGE] stage=scheduler.heartbeat). The full scan walks
    // DEFAULT_PHASE1_CONFIG.universe (~500 symbols), runs Phase 1–4
    // including stress / maturity / portfolio / elite approval; the
    // heartbeat tier just probes per-symbol cache for ~20 names.
    const universeSize = (() => {
      try {
        // Lazy-load to avoid pulling the constants module before
        // configureWatchlist primes the universe.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const c = require('@/lib/signal-engine/constants/signalEngine.constants');
        return Array.isArray(c.DEFAULT_PHASE1_CONFIG?.universe)
          ? c.DEFAULT_PHASE1_CONFIG.universe.length
          : null;
      } catch { return null; }
    })();
    console.log('[FULL_SCAN_START]', {
      stage:         'cron:signal-generation',
      universe_size: universeSize,
      started_at:    new Date(started).toISOString(),
    });
    try {
      // Lazy import to avoid pulling the monitor module before
      // bootstrapping is complete.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require('@/lib/monitor/institutionalHealth');
      m.recordFullScanStart({ universe_size: universeSize });
    } catch { /* monitor optional */ }
    log.info('[REGEN] signal generation starting');

    const portfolio: PortfolioSnapshot = {
      capital:        DEFAULT_PHASE3_CONFIG.defaultCapital,
      cashAvailable:  DEFAULT_PHASE3_CONFIG.defaultCapital,
      openPositions:  [],
      pendingSignals: [],
    };

    let result: Awaited<ReturnType<typeof generatePhase4Signals>>;
    try {
      result = await generatePhase4Signals(
        signalCandleProvider,
        portfolio,
        undefined, undefined, undefined, undefined,
        { generationSource: 'cron:signal-generation' },
      );
    } catch (err) {
      const elapsedMs = Date.now() - started;
      console.warn('[FULL_SCAN_COMPLETE]', {
        stage:      'cron:signal-generation',
        ok:         false,
        error:      err instanceof Error ? err.message : String(err),
        elapsed_ms: elapsedMs,
      });
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const m = require('@/lib/monitor/institutionalHealth');
        m.recordFullScanComplete({ ok: false, elapsed_ms: elapsedMs });
      } catch { /* monitor optional */ }
      throw err;
    }

    const approved = result.signals.filter(s => s.executionReadiness.approvalDecision === 'approved').length;
    const elapsedMs = Date.now() - started;
    // Provider coverage probe — best-effort. The [SCAN_COVERAGE] tag
    // is already emitted inside Phase 3, but [FULL_SCAN_COMPLETE]
    // surfaces the run-level summary so operators don't have to
    // correlate two log lines.
    const providerCoveragePct = universeSize && universeSize > 0
      ? Math.round((result.meta.scanned / universeSize) * 1000) / 10
      : null;
    console.log('[FULL_SCAN_COMPLETE]', {
      stage:           'cron:signal-generation',
      universe_size:   universeSize,
      scanned:         result.meta.scanned,
      approved,
      total:           result.signals.length,
      rejected:        result.meta.rejected,
      elapsed_ms:      elapsedMs,
      ok:              true,
      provider_coverage_pct: providerCoveragePct,
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const m = require('@/lib/monitor/institutionalHealth');
      m.recordFullScanComplete({
        ok:        true,
        scanned:   result.meta.scanned,
        approved,
        rejected:  result.meta.rejected,
        elapsed_ms: elapsedMs,
        provider_coverage_pct: providerCoveragePct,
      });
    } catch { /* monitor optional */ }
    log.info('[REGEN] signal generation complete', {
      scanned: result.meta.scanned,
      approved,
      total: result.signals.length,
      rejected: result.meta.rejected,
      elapsedMs,
    });
  })().finally(() => { signalGenInFlight = null; });
  return signalGenInFlight;
}

// ── Nightly backtest ─────────────────────────────────────────────

function ymd(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function runNightlyBacktest(): Promise<void> {
  const started = Date.now();
  log.info('nightly backtest starting');

  await ensureBacktestTables();

  const endDate = ymd(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const config = { ...DEFAULT_BACKTEST_CONFIG, name: `Nightly Backtest ${ymd(new Date())}`, endDate };
  const result = await runBacktest(config);

  if (result.status !== 'completed') {
    throw new Error(`Backtest ${result.status}: ${result.error ?? 'unknown'}`);
  }

  try {
    await persistFullRun(result);
  } catch (err) {
    log.warn('persistFullRun failed', { err: (err as Error).message });
  }

  log.info('nightly backtest complete', {
    signals: result.signalCount,
    trades:  result.tradeCount,
    winRate: result.summary?.winRate,
    totalReturnPct: result.summary?.totalReturnPct,
    elapsedMs: Date.now() - started,
  });
}

// ── Boot ─────────────────────────────────────────────────────────

log.info('worker-scheduler starting', { timezone: IST });

// 1. Market-data ingestion — canonical 10-minute IST cadence.
startMarketDataScheduler();

// 2. 18:30 IST — signal generation (post-close, Mon–Fri).
cron.schedule('30 18 * * 1-5', () => {
  runSignalGeneration().catch(err => {
    log.error('signal generation failed', { err: (err as Error).message });
  });
}, { timezone: IST });

// 3. 19:00 IST — nightly backtest (Mon–Fri).
cron.schedule('0 19 * * 1-5', () => {
  runNightlyBacktest().catch(err => {
    log.error('nightly backtest failed', { err: (err as Error).message });
  });
}, { timezone: IST });

// 3b. 19:30 IST — daily EOD ingestion + manipulation scan (Mon–Fri).
//
// Free-source EOD pipeline: pulls NSE bhavcopy (BSE / bulk-deal / ASM
// in a future round), upserts into the `candles` warehouse, then runs
// runManipulationScan() against the freshly-ingested candles so the
// Manipulation Watch surface advances every trading day.
//
// 19:30 is chosen because the NSE Common Bhavcopy is typically
// published by ~18:00 IST. Running 90 min later gives the upstream
// publisher slack for late files (festive sessions, half-days) while
// still landing well before the 22:00 IST log rotation.
//
// Overlap guard via `manipulationEodJobRunning`: the pipeline can run
// long on slow VPS (~3 min per 500 symbols), and on a manual trigger
// the cron tick must NOT stack a second concurrent scan.
//
// Crash-safe: every adapter resolves with a status envelope (never
// throws), and the wrapper catches anything unexpected. The scheduler
// loop cannot be killed by a flaky upstream URL.
let manipulationEodJobRunning = false;
cron.schedule('30 19 * * 1-5', async () => {
  if (manipulationEodJobRunning) {
    log.warn('[EOD-MANIPULATION] previous run still in flight — skipping this tick');
    return;
  }
  manipulationEodJobRunning = true;
  try {
    // Lazy import keeps the scheduler boot path free of any heavy
    // module-evaluation side effects from the manipulation engine.
    const { runDailyManipulationScan } = await import(
      '@/lib/manipulation-engine/pipeline/runDailyScan'
    );
    const result = await runDailyManipulationScan();
    log.info('[EOD-MANIPULATION] complete', {
      ok:                  result.ok,
      candlesAdvanced:     result.candlesAdvanced,
      candleDateBefore:    result.candleDateBefore,
      candleDateAfter:     result.candleDateAfter,
      latestEventDate:     result.latestEventDate,
      ingestionSources:    result.ingestion?.sources?.map((s) => ({
        src:      s.source,
        status:   s.status,
        fetched:  s.fetched,
        inserted: s.inserted,
        updated:  s.updated,
      })) ?? [],
      scanned:             result.scan.scanned,
      snapshotsPersisted:  result.scan.snapshotsPersisted,
      penaltiesWritten:    result.scan.penaltiesWritten,
      warnings:            result.warnings,
    });
  } catch (err) {
    log.error('[EOD-MANIPULATION] unexpected error', { err: (err as Error).message });
  } finally {
    manipulationEodJobRunning = false;
  }
}, { timezone: IST });

// 4. Dynamic ranking rescore — every 1 min, 09:20–15:30 IST, Mon–Fri.
//
// This is the loop that turns the signal board from a frozen
// snapshot into a live ranking. It walks every active/watchlist/
// flagged row, pulls a live LTP (Kite primary, Yahoo fallback), // @deprecated marker
// recomputes freshness + validator + final_score, and persists in
// one chunked UPDATE. An in-flight guard inside
// rescoreActiveSignals() prevents overlap when a run takes longer
// than the 1-min tick.
//
// Cadence is deliberately tight inside the session — a trader
// looking at the dashboard mid-morning should see ranks that
// reflect the last minute of tape, not yesterday's close. LUPIN
// running past target at 10:03 drops out of the top by 10:04.
// Step 8 of the budget-fix PR: rescore cron is */5, not every minute.
// The original `*` matched every minute (~360 ticks/day), wasting
// IndianAPI calls on per-row LTPs that barely move minute-to-minute.
// The file's own header comment said "5-minute" — the cron string
// was the bug. */5 = ~72 ticks/day during the window.
cron.schedule('*/5 9-15 * * 1-5', () => {
  // Confine to 09:20–15:30 IST without a second cron line.
  const now = new Date();
  const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 5 * 60 + 30) % (24 * 60);
  if (istMinutes < 9 * 60 + 20 || istMinutes > 15 * 60 + 30) return;

  rescoreActiveSignals()
    .then(r => log.info('[RESCORE] complete', {
      scanned: r.scanned, updated: r.updated,
      invalidated: r.invalidated, downgraded: r.downgraded,
      skippedNoPrice: r.skippedNoPrice,
      kiteHits: r.kiteHits, yahooHits: r.yahooHits, otherHits: r.otherHits, // @deprecated marker
      failedFetches: r.failedFetches, elapsedMs: r.elapsedMs,
    }))
    .catch(err => log.error('[RESCORE] failed', { err: (err as Error).message }));
}, { timezone: IST });

// 5. Intraday signal regeneration — every 10 min, 09:30–15:30 IST, Mon–Fri.
//
// Full Phase 1–4 pipeline: re-scans the universe, recomputes
// features from the latest daily candles (refreshed by the 10-min
// market-data loop), produces fresh signals, INSERTs new rows and
// expires same-symbol actives. This is the loop that introduces
// NEW symbols into the top 50 during the session — without it the
// only new signals you'd see are at 18:30 post-close.
//
// 10 min matches the market-data refresh cadence: every time a
// fresh candle batch lands, we get a chance to re-evaluate every
// symbol against it. The in-flight guard in runSignalGeneration
// ensures overlapping ticks skip rather than queue — on a slow
// VPS you may see one or two skipped ticks per hour; that's safe.
cron.schedule('*/10 9-15 * * 1-5', () => {
  const now = new Date();
  const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 5 * 60 + 30) % (24 * 60);
  if (istMinutes < 9 * 60 + 30 || istMinutes > 15 * 60 + 30) return;

  runSignalGeneration()
    .catch(err => log.error('[REGEN] intraday generation failed', { err: (err as Error).message }));
}, { timezone: IST });

// 6. Confirmed-snapshot lifecycle — every 30 s, 24x7.
//
// Walks ACTIVE rows in q365_confirmed_signal_snapshots, applies
// price-driven transitions (TARGET_HIT / STOP_LOSS_HIT /
// INVALIDATED) and validity-window EXPIRED. THIS IS THE ONLY
// process allowed to mutate snapshot rows, and it only changes
// the status field — entry / stop / target / score / explanation
// stay frozen.
//
// 24x7 because validity windows can elapse outside market hours
// (a snapshot confirmed at 14:30 with a 90-min validity will
// EXPIRE at 16:00 IST, after close).
let snapshotLifecycleInFlight: Promise<void> | null = null;
const SNAPSHOT_LIFECYCLE_INTERVAL_MS = 30_000;
setInterval(() => {
  if (snapshotLifecycleInFlight) return;
  snapshotLifecycleInFlight = (async () => {
    try {
      const { runConfirmedSnapshotLifecycle } = await import('@/lib/cron/confirmedSnapshotLifecycle');
      const r = await runConfirmedSnapshotLifecycle();
      if (r.scanned > 0 || r.expired > 0 || r.target_hit > 0
       || r.stop_loss_hit > 0 || r.invalidated > 0) {
        log.info('[SNAPSHOT-LIFECYCLE]', {
          scanned: r.scanned, expired: r.expired,
          target_hit: r.target_hit, stop_loss_hit: r.stop_loss_hit,
          invalidated: r.invalidated, unchanged: r.unchanged,
          failedFetches: r.failedFetches, elapsedMs: r.elapsedMs,
        });
      }
    } catch (err: any) {
      log.error('[SNAPSHOT-LIFECYCLE] failed', { err: err?.message ?? String(err) });
    } finally {
      snapshotLifecycleInFlight = null;
    }
  })();
}, SNAPSHOT_LIFECYCLE_INTERVAL_MS);

// 7. Signal maturity worker — every 60 s, 24x7.
//
// Walks q365_signal_maturity_tracker, recomputes maturity from the
// latest matching q365_signals row, persists score + stage. Promotes
// mature rows into q365_confirmed_signal_snapshots ONLY when
// validation cycles + age + score + stability all clear. This is
// the only path to a confirmed snapshot — saveSignals just upserts
// the tracker.
let maturityInFlight: Promise<void> | null = null;
const MATURITY_INTERVAL_MS = 60_000;
setInterval(() => {
  if (maturityInFlight) return;
  maturityInFlight = (async () => {
    try {
      const { runSignalMaturityWorker } = await import('@/lib/cron/signalMaturity');
      const r = await runSignalMaturityWorker();
      if (r.scanned > 0 || r.promoted > 0) {
        log.info('[MATURITY]', {
          scanned: r.scanned, promoted: r.promoted,
          matured: r.matured, developing: r.developing,
          candidate: r.candidate,
          regime_blocked: r.regime_blocked,
          failed: r.failed,
          elapsedMs: r.elapsedMs,
        });
      }
    } catch (err: any) {
      log.error('[MATURITY] failed', { err: err?.message ?? String(err) });
    } finally {
      maturityInFlight = null;
    }
  })();
}, MATURITY_INTERVAL_MS);

// 8. Backtest queue drain — every 1 min, 24x7.
//
// Recovery path for the queued-backtest execution flow added in the
// queue-hardening PR. POST /api/backtests already fires
// processBacktestRun(runId) in-process, but if the Node web server
// restarts (or the in-process tick was lost), a row can sit in the
// 'queued' state with no one to pick it up. This cron tick drains
// one queued row per minute as a backstop.
//
// Queue worker is safe to call repeatedly; runner uses atomic
// status transition (UPDATE … WHERE status='queued') to prevent
// duplicate execution across this cron, the in-process trigger, the
// manual /api/backtests/process-queue route, AND any peer Node
// instance behind a load balancer.
//
// Disabled cleanly via BACKTEST_QUEUE_SCHEDULER_ENABLED=false.
const BACKTEST_QUEUE_SCHEDULER_ENABLED =
  process.env.BACKTEST_QUEUE_SCHEDULER_ENABLED !== 'false';
let backtestQueueDrainRunning = false;
if (BACKTEST_QUEUE_SCHEDULER_ENABLED) {
  cron.schedule('* * * * *', async () => {
    if (backtestQueueDrainRunning) return; // local overlap guard
    backtestQueueDrainRunning = true;
    try {
      const result = await processQueuedBacktestRuns(1);
      // Stay quiet on idle ticks — only log when work was dispatched
      // or the queue is non-empty so PM2 logs aren't flooded.
      if (result.processed.length > 0 || result.remaining > 0) {
        log.info('[BACKTEST-QUEUE]', {
          dispatched: result.processed,
          remaining:  result.remaining,
          running:    result.running,
        });
      }
    } catch (err: any) {
      log.error('[BACKTEST-QUEUE] drain failed', { err: err?.message ?? String(err) });
    } finally {
      backtestQueueDrainRunning = false;
    }
  });
}

log.info('worker-scheduler ready', {
  marketDataCadence: '09:20 warmup · 09:30-15:30 @ 10m · 15:35 post-close',
  nightlyJobs: [
    '18:30 signal-generation',
    '19:00 backtest',
    '19:30 eod-manipulation (NSE bhavcopy + manipulation scan)',
  ],
  intradayJobs: [
    '*/1 min  rescore             (09:20-15:30 IST) — live ranking + decay',
    '*/10 min regen               (09:30-15:30 IST) — full Phase 1-4 pipeline',
    '30s     snapshot-lifecycle  (24x7)            — confirmed snapshot status mutations',
    '60s     maturity-worker     (24x7)            — promote mature trackers to confirmed snapshots',
    BACKTEST_QUEUE_SCHEDULER_ENABLED
      ? '60s     backtest-queue-drain (24x7)       — recovery for queued backtests'
      : '         backtest-queue-drain (disabled via BACKTEST_QUEUE_SCHEDULER_ENABLED=false)',
  ],
});

process.on('SIGTERM', () => {
  log.info('SIGTERM — shutting down worker-scheduler');
  process.exit(0);
});

process.on('SIGINT', () => {
  log.info('SIGINT — shutting down worker-scheduler');
  process.exit(0);
});

process.on('uncaughtException', err => {
  log.error('uncaughtException', { err: err.message });
});

process.on('unhandledRejection', reason => {
  log.error('unhandledRejection', { reason: String(reason) });
});
