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
 *     08:30 IST — readiness check (no signals)
 *     09:20 IST — first DB-only confirmation scan
 *     09:45 IST — main DB-only morning scan
 *     12:30 IST — active signal rescore
 *     14:45 IST — late rescore / confirmation
 *     16:00 IST — evening incremental candle update (IndianAPI)
 *     16:30 IST — final EOD DB-only scan
 *     19:00 IST — nightly backtest
 *     18:30 IST — manipulation scan (scan-only, separate pipeline)
 *
 * Signal generation at 18:30 IST is superseded by the 16:30 evening
 * scan unless SIGNAL_LEGACY_EVENING_SCAN_1830=true.
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

// ── Load project env (`.env` on prod, `.env.local` in dev when present) ─
import { config as dotenvConfig } from 'dotenv';
import { resolveEnvFilePath } from '@/lib/envPath';
dotenvConfig({ path: resolveEnvFilePath() });

// ── Bootstrap path aliases (ts-node doesn't support @/ by default) ─
import 'tsconfig-paths/register';

import cron from 'node-cron';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { startScheduler as startMarketDataScheduler } from '@/lib/scheduler';
import { startDailyScanSchedule } from '@/lib/workers/dailyScanSchedule';
import { startWeeklyUniverseSchedule } from '@/lib/marketData/weeklyUniverseSchedule';
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
import { isSignalIntradayRegenEnabled } from '@/lib/signal-engine/schedule/signalSchedulePolicy';

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
        // eslint-disable-next-line
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
      // eslint-disable-next-line
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
        // eslint-disable-next-line
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
      // eslint-disable-next-line
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

// 2. Daily scan schedule — controlled IST cadence (see docs/DAILY_SCAN_SCHEDULE.md).
startDailyScanSchedule();

// 2b. Weekly NSE 1000 universe rebuild — Sunday 22:00 IST by default.
startWeeklyUniverseSchedule();

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

// 4. Dynamic ranking rescore — DISABLED by default.
//
// Controlled schedule runs rescore at 12:30 and 14:45 IST via
// dailyScanSchedule.ts. Enable legacy */5 intraday rescore only when
// SIGNAL_INTRADAY_REGEN_ENABLED=true (not recommended for prod).
if (isSignalIntradayRegenEnabled()) {
  cron.schedule('*/5 9-15 * * 1-5', () => {
    const now = new Date();
    const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 5 * 60 + 30) % (24 * 60);
    if (istMinutes < 9 * 60 + 20 || istMinutes > 15 * 60 + 30) return;

    rescoreActiveSignals()
      .then(r => log.info('[RESCORE] complete', {
        scanned: r.scanned, updated: r.updated,
        invalidated: r.invalidated, downgraded: r.downgraded,
        skippedNoPrice: r.skippedNoPrice,
        kiteHits: r.kiteHits, yahooHits: r.yahooHits, otherHits: r.otherHits,
        failedFetches: r.failedFetches, elapsedMs: r.elapsedMs,
      }))
      .catch(err => log.error('[RESCORE] failed', { err: (err as Error).message }));
  }, { timezone: IST });
} else {
  log.info('[RESCORE] legacy */5 cron disabled — use controlled 12:30/14:45 schedule');
}

// 5. Intraday signal regeneration — OFF by default (SIGNAL_INTRADAY_REGEN_ENABLED=false).
//
// Full Phase 1–4 every 10 min is replaced by the controlled daily scan
// schedule (09:20 / 09:45 / 16:30). Opt in only for debugging.
if (isSignalIntradayRegenEnabled()) {
  cron.schedule('*/10 9-15 * * 1-5', () => {
    const now = new Date();
    const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 5 * 60 + 30) % (24 * 60);
    if (istMinutes < 9 * 60 + 30 || istMinutes > 15 * 60 + 30) return;

    runSignalGeneration()
      .catch(err => log.error('[REGEN] intraday generation failed', { err: (err as Error).message }));
  }, { timezone: IST });
} else {
  log.info('[REGEN] 10-min intraday Phase-4 regen disabled (SIGNAL_INTRADAY_REGEN_ENABLED=false)');
}

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

// 7b. Production alert monitor — every 5 min, 24x7.
//
// PRODUCTION-READINESS 2026-07 §6.2 — evaluates the signal-pipeline
// alert rules (no confirmed signals during market hours, live feed
// stale, scanner stuck in-flight, IndianAPI quota >90%) plus the
// PRODUCTION-ALERTS-2026-05 set, and delivers warning/critical hits
// via Slack / email / system notifications. The q365_alerts store
// dedups by rule id so persistent conditions don't spam.
// Disable with ALERT_MONITOR_DISABLED=true.
let alertMonitorInFlight: Promise<void> | null = null;
const ALERT_MONITOR_INTERVAL_MS = 5 * 60_000;
if (process.env.ALERT_MONITOR_DISABLED !== 'true') {
  setInterval(() => {
    if (alertMonitorInFlight) return;
    alertMonitorInFlight = (async () => {
      try {
        const { dispatchAlerts } = await import('@/lib/reliability/alertDispatcher');
        const r = await dispatchAlerts();
        if (r.dispatched > 0) {
          log.warn('[ALERT-MONITOR] dispatched alerts', {
            evaluated: r.evaluated, dispatched: r.dispatched,
            deliveries: r.deliveries,
          });
        }
      } catch (err: any) {
        log.error('[ALERT-MONITOR] failed', { err: err?.message ?? String(err) });
      } finally {
        alertMonitorInFlight = null;
      }
    })();
  }, ALERT_MONITOR_INTERVAL_MS);
}

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
  dailyScanSchedule: [
    '08:30 readiness (no signals)',
    '09:20 first morning scan (DB-only)',
    '09:45 main morning scan (DB-only)',
    '12:30 midday rescore',
    '14:45 late rescore',
    '16:00 evening EOD candle update (IndianAPI)',
    '16:30 evening scan (DB-only)',
    '18:30 manipulation scan (scan-only)',
  ],
  nightlyJobs: [
    '19:00 backtest',
    '19:30 eod-manipulation (NSE bhavcopy + manipulation scan)',
  ],
  weeklyUniverseRebuild: {
    enabled: process.env.UNIVERSE_WEEKLY_REBUILD_ENABLED !== 'false',
    cron: process.env.UNIVERSE_WEEKLY_REBUILD_CRON ?? '0 22 * * 0 (Sun 22:00 IST)',
    churn: 'add<=900 keep<=1100 remove>1200',
  },
  disabledByDefault: {
    preopen_candle_warmup: 'PREOPEN_CANDLE_WARMUP_ENABLED=false',
    intraday_regen: 'SIGNAL_INTRADAY_REGEN_ENABLED=false',
    legacy_rescore: 'SIGNAL_INTRADAY_REGEN_ENABLED=false (use 12:30/14:45)',
    auto_recovery: 'SIGNALS_AUTO_RECOVERY_ENABLED=false',
    poll_auto_recovery: 'SIGNALS_AUTO_RECOVERY_ALLOW_ON_READ=false',
    legacy_1830_signal_scan: 'SIGNAL_LEGACY_EVENING_SCAN_1830=false',
  },
  alwaysOn: [
    '30s snapshot-lifecycle (24x7)',
    '60s maturity-worker (24x7)',
    process.env.ALERT_MONITOR_DISABLED !== 'true'
      ? '5m production-alert-monitor (24x7)'
      : 'production-alert-monitor disabled',
    BACKTEST_QUEUE_SCHEDULER_ENABLED
      ? '60s backtest-queue-drain (24x7)'
      : 'backtest-queue-drain disabled',
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
