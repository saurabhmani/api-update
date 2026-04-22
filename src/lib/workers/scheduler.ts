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
 *   → Yahoo → PostgreSQL) and writes one structured run log.
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
 *     17:45 IST — Yahoo daily backfill       (Yahoo is fallback-only now)
 *     18:00 IST — EOD snapshot               (superseded by 15:35 post-close)
 *
 * Start:  npx ts-node src/lib/workers/scheduler.ts
 * PM2:    pm2 start src/lib/workers/scheduler.ts --name quantorus365-scheduler
 */

// ── Load .env.local before anything else (VPS: PM2 doesn't load it) ─
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
dotenvConfig({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

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

// In-flight guard: at a 10-min regen cadence a slow Yahoo fallback
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
    log.info('[REGEN] signal generation starting');

    const portfolio: PortfolioSnapshot = {
      capital:        DEFAULT_PHASE3_CONFIG.defaultCapital,
      cashAvailable:  DEFAULT_PHASE3_CONFIG.defaultCapital,
      openPositions:  [],
      pendingSignals: [],
    };

    const result = await generatePhase4Signals(
      signalCandleProvider,
      portfolio,
      undefined, undefined, undefined, undefined,
      { generationSource: 'cron:signal-generation' },
    );

    const approved = result.signals.filter(s => s.executionReadiness.approvalDecision === 'approved').length;
    log.info('[REGEN] signal generation complete', {
      scanned: result.meta.scanned,
      approved,
      total: result.signals.length,
      rejected: result.meta.rejected,
      elapsedMs: Date.now() - started,
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

// 4. Dynamic ranking rescore — every 1 min, 09:20–15:30 IST, Mon–Fri.
//
// This is the loop that turns the signal board from a frozen
// snapshot into a live ranking. It walks every active/watchlist/
// flagged row, pulls a live LTP (Kite primary, Yahoo fallback),
// recomputes freshness + validator + final_score, and persists in
// one chunked UPDATE. An in-flight guard inside
// rescoreActiveSignals() prevents overlap when a run takes longer
// than the 1-min tick.
//
// Cadence is deliberately tight inside the session — a trader
// looking at the dashboard mid-morning should see ranks that
// reflect the last minute of tape, not yesterday's close. LUPIN
// running past target at 10:03 drops out of the top by 10:04.
cron.schedule('* 9-15 * * 1-5', () => {
  // Confine to 09:20–15:30 IST without a second cron line.
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

log.info('worker-scheduler ready', {
  marketDataCadence: '09:20 warmup · 09:30-15:30 @ 10m · 15:35 post-close',
  nightlyJobs: ['18:30 signal-generation', '19:00 backtest'],
  intradayJobs: [
    '*/1 min  rescore   (09:20-15:30 IST) — live ranking + decay',
    '*/10 min regen     (09:30-15:30 IST) — full Phase 1-4 pipeline',
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
