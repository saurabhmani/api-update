// ════════════════════════════════════════════════════════════════
//  Market-data scheduler — 3-TIER REDESIGN
//
//  The old scheduler ran per-symbol live snapshot fetches every 10
//  minutes across the full watchlist. That model does not scale to
//  500 symbols under any reasonable API budget.
//
//  New model (see src/lib/marketData/batchScheduler.ts):
//
//    TIER A  every 10 min   batch quotes + market-wide endpoints
//    TIER B  every 20 min   trigger-evaluated deep fetches (max 6/cycle)
//    TIER C  every 60 min   news + historical refresh
//
//  Plus:
//    09:20 IST warmup       one batch call only
//    15:35 IST post-close   one batch call, persist
//
//  All cron jobs are gated by the batchScheduler's internal
//  budget/cooldown logic — this file is now a thin cron harness.
//
//  Backwards compatibility:
//    configureWatchlist()       — delegates to schedulerConfig.configureTiers
//    runSchedulerPassOnce()     — alias of runBatchTier() (manual trigger)
//    startScheduler()           — registers the new cron jobs
//    stopScheduler()            — unchanged
// ════════════════════════════════════════════════════════════════

import cron, { ScheduledTask } from 'node-cron';
import { logger } from '@/lib/logger';
import { configureTiers, getBatchUniverse } from '@/lib/marketData/schedulerConfig';
import {
  runBatchTier,
  runTriggerTier,
  runIntelTier,
  runHeartbeatTier,
} from '@/lib/marketData/providers/batchScheduler';

const log = logger.child({ component: 'marketScheduler' });

// ── Backwards-compatible watchlist API ──────────────────────────────
// The old entrypoint promoted a single "watchlist" concept. The new
// model is tiered, but we keep this wrapper so any existing boot
// code that calls configureWatchlist(symbols) keeps working — we
// treat the incoming list as Tier 2.

const DEFAULT_WATCHLIST = (process.env.SCHEDULER_WATCHLIST ??
  'RELIANCE,TCS,HDFCBANK,INFY,ICICIBANK,SBIN,HINDUNILVR,ITC,LT,KOTAKBANK')
  .split(',').map(s => s.trim()).filter(Boolean);

export function configureWatchlist(symbols: string[]): void {
  const clean = [...new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))];
  configureTiers({ tier2: clean });
  log.info('watchlist updated (mapped to tier 2)', { count: clean.length });
}

// Prime tier2 from env at module load so any caller that never
// invokes configureWatchlist() still gets the legacy default set.
configureTiers({ tier2: DEFAULT_WATCHLIST });

// ── Cron registration ───────────────────────────────────────────────

const IST = 'Asia/Kolkata';
const tasks: ScheduledTask[] = [];

// Guard every handler: node-cron's window is generous, we want
// strict market-hours gating (09:30 → 15:30 IST).
function inMarketWindow(): boolean {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: IST }));
  const dow = now.getDay();                    // 0=Sun, 6=Sat
  if (dow === 0 || dow === 6) return false;
  const hm = now.getHours() * 60 + now.getMinutes();
  return hm >= (9 * 60 + 30) && hm <= (15 * 60 + 30);
}

export function startScheduler(): void {
  if (tasks.length > 0) {
    log.warn('scheduler already started — ignoring duplicate start');
    return;
  }

  // 09:20 IST — pre-open warmup (single batch call only)
  tasks.push(cron.schedule('20 9 * * 1-5', () => {
    void runBatchTier().catch(err => log.error('warmup failed', { err: String(err) }));
  }, { timezone: IST }));

  // 09:25 IST — pre-open CANDLE warmup. Step 4(c) of the budget-fix
  // PR: ONE full-universe sweep per day (the only force=true call
  // that touches every active symbol). After this, the 15-min ticks
  // operate on a curated subset capped at CANDLE_MAX_PER_CYCLE.
  // This call's cost is bounded by the active universe size
  // (NIFTY 500 by default = 500 historical fetches/day, ~11k/month).
  tasks.push(cron.schedule('25 9 * * 1-5', () => {
    void (async () => {
      try {
        const [{ refreshDailyCandles }, { DEFAULT_PHASE1_CONFIG, loadTradeableUniverse }] =
          await Promise.all([
            import('@/lib/marketData/candleIngest'),
            import('@/lib/signal-engine/constants/signalEngine.constants'),
          ]);
        await loadTradeableUniverse();
        const r = await refreshDailyCandles({
          symbols: DEFAULT_PHASE1_CONFIG.universe,
          force:   true,
          noCap:   true,
        });
        log.info('pre-open candle warmup complete', {
          requested: r.requested, refreshed: r.refreshed,
          bars: r.barsIngested, failed: r.failed.length,
        });
      } catch (err) {
        log.error('pre-open candle warmup failed', { err: String(err) });
      }
    })();
  }, { timezone: IST }));

  // ── TIER A — every 10 minutes during market hours ────────────────
  tasks.push(cron.schedule('*/10 9-15 * * 1-5', () => {
    if (!inMarketWindow()) return;
    void runBatchTier().catch(err =>
      log.error('batch tier failed', { err: String(err) }),
    );
  }, { timezone: IST }));

  // ── HEARTBEAT — every minute during market hours ─────────────────
  // Spec FIX-DATA-PIPELINE §4: keep `last_pipeline_run` fresh between
  // 10-min batch cycles so the dashboard never reports the pipeline
  // as stuck. The heartbeat is cache-first + budget-guarded internally,
  // so the per-minute cadence is essentially free in API quota terms.
  tasks.push(cron.schedule('* 9-15 * * 1-5', () => {
    if (!inMarketWindow()) return;
    void runHeartbeatTier().catch(err =>
      log.error('heartbeat tier failed', { err: String(err) }),
    );
  }, { timezone: IST }));

  // ── TIER B — every 20 minutes during market hours ────────────────
  // Offset by 5 min relative to Tier A so Tier B runs AFTER Tier A
  // writes fresh batch data into cache. (cron semantics: 5,25,45…)
  tasks.push(cron.schedule('5,25,45 9-15 * * 1-5', () => {
    if (!inMarketWindow()) return;
    void runTriggerTier().catch(err =>
      log.error('trigger tier failed', { err: String(err) }),
    );
  }, { timezone: IST }));

  // ── TIER C — every 60 minutes during market hours ────────────────
  // Offset to :15 past the hour so it doesn't collide with Tier A/B.
  tasks.push(cron.schedule('15 9-15 * * 1-5', () => {
    if (!inMarketWindow()) return;
    void runIntelTier().catch(err =>
      log.error('intel tier failed', { err: String(err) }),
    );
  }, { timezone: IST }));

  // 15:35 IST — post-close sync (single batch call, persists closing prices)
  tasks.push(cron.schedule('35 15 * * 1-5', () => {
    void runBatchTier().catch(err =>
      log.error('post-close failed', { err: String(err) }),
    );
  }, { timezone: IST }));

  // Weekend news refresh — once at 09:00 IST Sat/Sun. Purely so the
  // news cache isn't 2 days stale on Monday morning. One API call.
  tasks.push(cron.schedule('0 9 * * 0,6', () => {
    void runIntelTier().catch(err =>
      log.error('weekend intel failed', { err: String(err) }),
    );
  }, { timezone: IST }));

  log.info('scheduler started', {
    timezone: IST,
    batchUniverse: getBatchUniverse().length,
    cronJobs: tasks.length,
    layout: {
      batch:     '*/10 9-15 * * 1-5',
      heartbeat: '* 9-15 * * 1-5',
      trigger:   '5,25,45 9-15 * * 1-5',
      intel:     '15 9-15 * * 1-5',
      warmup:    '20 9 * * 1-5',
      postClose: '35 15 * * 1-5',
    },
  });
}

export function stopScheduler(): void {
  for (const t of tasks) t.stop();
  tasks.length = 0;
  log.info('scheduler stopped');
}

// ── Backwards-compatible one-shot manual trigger ────────────────────
// Old code paths (ops endpoints, tests) import `runSchedulerPassOnce`.
// It now returns the batch-tier report, which is the closest analogue
// to the old "one full pass" semantics.
export { runBatchTier as runSchedulerPassOnce };

// Additional manual triggers for the new tiers — useful for tests
// and admin endpoints.
export { runBatchTier, runTriggerTier, runIntelTier };
