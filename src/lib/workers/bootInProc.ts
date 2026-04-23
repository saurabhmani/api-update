// ════════════════════════════════════════════════════════════════
//  In-process scheduler — dev-mode companion to workers/scheduler.ts
//
//  Problem:
//    `src/lib/workers/scheduler.ts` is a standalone Node entrypoint
//    started by PM2 in production (`pm2 start .../scheduler.ts`).
//    It runs outside the Next.js process. In dev (`npm run dev`),
//    nobody starts it — so the 1-min rescore and 10-min regen crons
//    never fire. Operators think LUPIN is "stuck forever" when the
//    real issue is that no cron ran between two manual refreshes.
//
//  Fix:
//    instrumentation.ts calls bootInProcScheduler() in dev. This
//    file registers the SAME crons as the standalone scheduler
//    (rescore + intraday regen), inside the Next runtime.
//
//    In prod we still rely on PM2 — single-process Next + cron is
//    fine for dev but unacceptable for prod because a Next restart
//    (on deploy, crash, etc.) would orphan the cron state. PM2's
//    process separation is the right boundary there.
//
//  HMR-safe:
//    Every cron handle + install marker lives on globalThis under
//    a stable key. A reload of this module finds the existing
//    handles, stops them, and re-registers — so you never end up
//    with 2× rescore loops after editing any signal-engine file.
// ════════════════════════════════════════════════════════════════

import cron, { type ScheduledTask } from 'node-cron';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'bootInProc' });
const IST = 'Asia/Kolkata';
const GLOBAL_KEY = '__q365_inproc_scheduler__';

interface InProcState {
  rescoreTask:       ScheduledTask | null;
  regenTask:         ScheduledTask | null;
  newsTask:          ScheduledTask | null;
  regenInFlight:     Promise<void> | null;
  newsInFlight:      Promise<void> | null;
  bootedAt:          number | null;
}

function getState(): InProcState {
  const g = globalThis as unknown as Record<string, InProcState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      rescoreTask:    null,
      regenTask:      null,
      newsTask:       null,
      regenInFlight:  null,
      newsInFlight:   null,
      bootedAt:       null,
    };
  }
  return g[GLOBAL_KEY]!;
}

/**
 * Gate: only boot the in-proc scheduler when explicitly allowed.
 *
 * Default: NODE_ENV === 'development' AND Q365_INPROC_SCHEDULER != '0'.
 * Override to force-enable in staging/prod: Q365_INPROC_SCHEDULER=1.
 * Override to force-disable in dev:          Q365_INPROC_SCHEDULER=0.
 *
 * Prod default (opt-out) matters: if you run `pm2 start scheduler.ts`
 * in prod, set Q365_INPROC_SCHEDULER=0 on the Next process so the
 * crons don't fire twice.
 */
function shouldBoot(): boolean {
  const explicit = process.env.Q365_INPROC_SCHEDULER;
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  return process.env.NODE_ENV === 'development';
}

/**
 * Returns true if this minute falls inside 09:20–15:30 IST. Used as
 * a secondary gate inside each cron tick (cron's `9-15` hour match
 * is coarser than we need for the exact ladder boundaries).
 */
function isInsideRescoreWindow(): boolean {
  const now = new Date();
  const istMinutes =
    (now.getUTCHours() * 60 + now.getUTCMinutes() + 5 * 60 + 30) % (24 * 60);
  return istMinutes >= 9 * 60 + 20 && istMinutes <= 15 * 60 + 30;
}

function isInsideRegenWindow(): boolean {
  const now = new Date();
  const istMinutes =
    (now.getUTCHours() * 60 + now.getUTCMinutes() + 5 * 60 + 30) % (24 * 60);
  return istMinutes >= 9 * 60 + 30 && istMinutes <= 15 * 60 + 30;
}

/**
 * Register (or re-register, HMR-safely) the in-process crons.
 * Idempotent: stops any existing handles before re-installing.
 */
export function bootInProcScheduler(): void {
  if (!shouldBoot()) {
    log.info('in-proc scheduler skipped (prod path — PM2 owns cron)', {
      nodeEnv: process.env.NODE_ENV,
      explicit: process.env.Q365_INPROC_SCHEDULER ?? '(unset)',
    });
    return;
  }

  const state = getState();

  // HMR: stop any cron handles from the previous module instance
  // before re-registering, otherwise we'd end up with N× handlers.
  if (state.rescoreTask) {
    try { state.rescoreTask.stop(); } catch { /* already stopped */ }
    state.rescoreTask = null;
  }
  if (state.regenTask) {
    try { state.regenTask.stop(); } catch { /* already stopped */ }
    state.regenTask = null;
  }
  if (state.newsTask) {
    try { state.newsTask.stop(); } catch { /* already stopped */ }
    state.newsTask = null;
  }

  // ── 1-minute rescore ─────────────────────────────────────────
  state.rescoreTask = cron.schedule('* 9-15 * * 1-5', () => {
    if (!isInsideRescoreWindow()) return;
    (async () => {
      try {
        const { rescoreActiveSignals } = await import(
          '@/lib/signal-engine/rescore/rescoreActiveSignals'
        );
        const r = await rescoreActiveSignals();
        log.info('[INPROC RESCORE] complete', {
          scanned: r.scanned, updated: r.updated,
          invalidated: r.invalidated, downgraded: r.downgraded,
          staleRescored: r.staleRescored,
          kiteHits: r.kiteHits, yahooHits: r.yahooHits,
          failedFetches: r.failedFetches, elapsedMs: r.elapsedMs,
        });
      } catch (err: any) {
        log.error('[INPROC RESCORE] failed', { err: err?.message ?? String(err) });
      }
    })();
  }, { timezone: IST });

  // ── 10-minute intraday regeneration (OPT-IN) ─────────────────
  //
  // Full Phase 1-4 pipeline over ~2943 stocks is 60-120s of CPU +
  // Yahoo/Kite fetches + heavy DB writes per tick. Running that
  // inside the Next dev process blocks the event loop and makes
  // the UI feel "heavy" — the symptom that prompted this gate.
  //
  // Default behaviour: DISABLED in-process. Regen belongs in the
  // standalone PM2 scheduler (workers/scheduler.ts) which runs as
  // its own Node process. Enable in-proc regen ONLY when you
  // explicitly want to test the end-to-end pipeline without PM2:
  //   Q365_INPROC_REGEN=1 npm run dev
  //
  // Rescore stays in-process always — it's cheap (a DB read + batch
  // live-price fetch + arithmetic + one chunked UPDATE), and it's
  // what makes the dashboard feel alive.
  const regenInProc = process.env.Q365_INPROC_REGEN === '1';
  if (regenInProc) {
    state.regenTask = cron.schedule('*/10 9-15 * * 1-5', () => {
      if (!isInsideRegenWindow()) return;
      if (state.regenInFlight) {
        log.warn('[INPROC REGEN] previous run still in flight — skipping');
        return;
      }
      state.regenInFlight = runRegenInProc()
        .catch((err) => log.error('[INPROC REGEN] failed', { err: err?.message ?? String(err) }))
        .finally(() => { state.regenInFlight = null; });
    }, { timezone: IST });
  }

  // ── 5-minute news pipeline (always on) ──────────────────────
  // Keeps q365_news_events fresh without the UI having to click
  // "Run Pipeline". RSS upstreams cache for several minutes so 5
  // minutes is the polite floor; faster and we'd just hammer our
  // own HTTP cache without getting fresher headlines.
  //
  // Self-coalescing via newsInFlight — a slow run that spans two
  // firings becomes a single run, not overlapping runs.
  state.newsTask = cron.schedule('*/5 * * * *', () => {
    if (state.newsInFlight) {
      log.warn('[INPROC NEWS] previous run still in flight — skipping');
      return;
    }
    state.newsInFlight = runNewsPipelineInProc()
      .catch((err) => log.error('[INPROC NEWS] failed', { err: err?.message ?? String(err) }))
      .finally(() => { state.newsInFlight = null; });
  }, { timezone: IST });

  // Fire once on boot so a fresh dev server populates the DB
  // immediately instead of waiting 5 min for the first cron tick.
  setTimeout(() => {
    if (state.newsInFlight) return;
    state.newsInFlight = runNewsPipelineInProc()
      .catch((err) => log.error('[INPROC NEWS] boot-fire failed', { err: err?.message ?? String(err) }))
      .finally(() => { state.newsInFlight = null; });
  }, 5_000);

  state.bootedAt = Date.now();
  log.info('in-proc scheduler booted', {
    jobs: [
      '*/1 min rescore (09:20-15:30 IST)',
      ...(regenInProc ? ['*/10 min regen (09:30-15:30 IST)'] : []),
      '*/5 min news ingestion (24x7)',
    ],
    regen_in_proc: regenInProc,
    regen_hint:    regenInProc ? undefined : 'regen disabled in-proc — run standalone scheduler.ts or POST /api/run-signal-engine',
  });
}

async function runNewsPipelineInProc(): Promise<void> {
  const started = Date.now();
  try {
    const { runFullPipeline } = await import('@/lib/news-engine/pipeline/runNewsPipeline');
    const result = await runFullPipeline('Indian stock market NSE', 15);
    log.info('[INPROC NEWS] complete', {
      fetched:   result.ingestion?.totalFetched ?? 0,
      newEvents: result.ingestion?.newEvents ?? 0,
      scored:    result.scoring?.totalScored ?? 0,
      elapsedMs: Date.now() - started,
    });
  } catch (err: any) {
    log.error('[INPROC NEWS] pipeline threw', { err: err?.message ?? String(err) });
  }
}

async function runRegenInProc(): Promise<void> {
  const started = Date.now();
  log.info('[INPROC REGEN] starting');

  // Lazy imports so HMR and cold-boot don't pay the cost of the
  // full Phase 4 pipeline module graph on every module reload.
  const [
    { db },
    { generatePhase4Signals, DEFAULT_PHASE3_CONFIG },
  ] = await Promise.all([
    import('@/lib/db'),
    import('@/lib/signal-engine'),
  ]);

  const candleProvider = {
    async fetchDailyCandles(symbol: string) {
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

  const portfolio = {
    capital:        DEFAULT_PHASE3_CONFIG.defaultCapital,
    cashAvailable:  DEFAULT_PHASE3_CONFIG.defaultCapital,
    openPositions:  [],
    pendingSignals: [],
  };

  const result = await generatePhase4Signals(
    candleProvider, portfolio,
    undefined, undefined, undefined, undefined,
    { generationSource: 'inproc:signal-generation' },
  );

  const approved = result.signals.filter(
    (s) => s.executionReadiness.approvalDecision === 'approved',
  ).length;

  log.info('[INPROC REGEN] complete', {
    scanned: result.meta.scanned,
    approved,
    total: result.signals.length,
    rejected: result.meta.rejected,
    elapsedMs: Date.now() - started,
  });
}

/** Stop all in-proc crons — useful for tests or graceful shutdown. */
export function stopInProcScheduler(): void {
  const state = getState();
  state.rescoreTask?.stop();
  state.regenTask?.stop();
  state.newsTask?.stop();
  state.rescoreTask = null;
  state.regenTask = null;
  state.newsTask = null;
  state.bootedAt = null;
  log.info('in-proc scheduler stopped');
}

/** Observability: report the current in-proc scheduler state. */
export function getInProcSchedulerStats(): {
  booted:       boolean;
  bootedAt:     number | null;
  regenInFlight: boolean;
} {
  const s = getState();
  return {
    booted:        s.rescoreTask != null || s.regenTask != null,
    bootedAt:      s.bootedAt,
    regenInFlight: s.regenInFlight != null,
  };
}
