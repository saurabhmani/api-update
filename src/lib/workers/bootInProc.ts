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
  /** Hourly full-market scan — always-on during NSE hours. Distinct
   *  from regenTask (the legacy 10-min opt-in path) so operators can
   *  keep both running, or run only the hourly one. */
  hourlyScanTask:    ScheduledTask | null;
  hourlyScanInFlight: Promise<void> | null;
  newsTask:          ScheduledTask | null;
  /** 15:30 IST market-close snapshot writer. Captures last-known
   *  prices for every active-universe symbol into
   *  q365_market_close_snapshot so off-hours resolver requests have
   *  a static-data tier behind the in-memory cache. */
  closeSnapshotTask: ScheduledTask | null;
  closeSnapshotInFlight: Promise<void> | null;
  /** setInterval handle for the 30s confirmed-snapshot lifecycle worker. */
  snapshotLifecycleHandle: ReturnType<typeof setInterval> | null;
  snapshotLifecycleInFlight: Promise<void> | null;
  /** setInterval handle for the 60s signal-maturity worker. */
  maturityHandle:           ReturnType<typeof setInterval> | null;
  maturityInFlight:         Promise<void> | null;
  /** setInterval handle for the 60s pipeline heartbeat. Bumps the
   *  Redis `scheduler:heartbeat:pipeline` key so the freshness probe
   *  in /api/signals can surface a non-null `last_pipeline_run` even
   *  while no confirmed snapshots exist yet. Spec FIX-DATA-PIPELINE §4. */
  heartbeatHandle:          ReturnType<typeof setInterval> | null;
  heartbeatInFlight:        Promise<void> | null;
  regenInFlight:     Promise<void> | null;
  newsInFlight:      Promise<void> | null;
  bootedAt:          number | null;
}

function getState(): InProcState {
  const g = globalThis as unknown as Record<string, InProcState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      rescoreTask:                null,
      regenTask:                  null,
      hourlyScanTask:             null,
      hourlyScanInFlight:         null,
      newsTask:                   null,
      closeSnapshotTask:          null,
      closeSnapshotInFlight:      null,
      snapshotLifecycleHandle:    null,
      snapshotLifecycleInFlight:  null,
      maturityHandle:             null,
      maturityInFlight:           null,
      heartbeatHandle:            null,
      heartbeatInFlight:          null,
      regenInFlight:              null,
      newsInFlight:               null,
      bootedAt:                   null,
    };
  }
  return g[GLOBAL_KEY]!;
}

/**
 * Gate: only boot the in-proc scheduler when explicitly allowed.
 *
 * Order of precedence:
 *   1. Q365_INPROC_SCHEDULER=1 → force ON
 *   2. Q365_INPROC_SCHEDULER=0 → force OFF (use this when PM2 owns cron)
 *   3. Q365_INPROC_REGEN=1     → ON (operators set this to enable the
 *                                in-process pipeline; without it the
 *                                gate would silently stay off in prod
 *                                and the dashboard would show empty
 *                                "Last Pipeline Run: —" forever).
 *   4. NODE_ENV === 'development' → ON (dev convenience)
 *   5. Otherwise → OFF
 *
 * Q365_INPROC_REGEN historically only toggled the 10-min regen sub-
 * cron *inside* this file — but the .env.example comment marketed it
 * as the master switch ("with =1 the Next server itself runs the
 * pipeline cron"). Treating it as a boot signal too keeps that
 * documented contract honest. If you run `pm2 start scheduler.ts` in
 * prod, set Q365_INPROC_SCHEDULER=0 explicitly to suppress this and
 * avoid double-firing crons.
 */
function shouldBoot(): boolean {
  const explicit = process.env.Q365_INPROC_SCHEDULER;
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  if (process.env.Q365_INPROC_REGEN === '1') return true;
  return process.env.NODE_ENV === 'development';
}

/**
 * Override: when Q365_REGEN_24X7=1 the rescore + regen crons run
 * regardless of clock time / day-of-week. Useful in dev / staging when
 * the operator wants the dashboard to behave as if the market is open
 * so the filter pipeline produces fresh output continuously.
 *
 * Caveat: outside real market hours the underlying daily candles don't
 * change, so re-running Phase-4 on the same input produces the same
 * signals. The override removes the cron gate; it can't manufacture
 * data the market hasn't generated.
 */
function isRegenAlwaysOn(): boolean {
  return process.env.Q365_REGEN_24X7 === '1';
}

/**
 * Returns true if this minute falls inside 09:20–15:30 IST. Used as
 * a secondary gate inside each cron tick (cron's `9-15` hour match
 * is coarser than we need for the exact ladder boundaries).
 */
function isInsideRescoreWindow(): boolean {
  if (isRegenAlwaysOn()) return true;
  const now = new Date();
  const istMinutes =
    (now.getUTCHours() * 60 + now.getUTCMinutes() + 5 * 60 + 30) % (24 * 60);
  return istMinutes >= 9 * 60 + 20 && istMinutes <= 15 * 60 + 30;
}

function isInsideRegenWindow(): boolean {
  if (isRegenAlwaysOn()) return true;
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
    log.warn('in-proc scheduler SKIPPED — no rescore/regen/lifecycle crons will fire in this process', {
      nodeEnv: process.env.NODE_ENV,
      Q365_INPROC_SCHEDULER: process.env.Q365_INPROC_SCHEDULER ?? '(unset)',
      Q365_INPROC_REGEN:     process.env.Q365_INPROC_REGEN ?? '(unset)',
      hint: 'expected when PM2 runs scheduler.ts separately. If the dashboard shows "Last Pipeline Run: —", set Q365_INPROC_SCHEDULER=1 (or Q365_INPROC_REGEN=1) on this process.',
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
  if (state.hourlyScanTask) {
    try { state.hourlyScanTask.stop(); } catch { /* already stopped */ }
    state.hourlyScanTask = null;
  }
  if (state.newsTask) {
    try { state.newsTask.stop(); } catch { /* already stopped */ }
    state.newsTask = null;
  }
  if (state.closeSnapshotTask) {
    try { state.closeSnapshotTask.stop(); } catch { /* already stopped */ }
    state.closeSnapshotTask = null;
  }
  if (state.snapshotLifecycleHandle) {
    try { clearInterval(state.snapshotLifecycleHandle); } catch { /* already cleared */ }
    state.snapshotLifecycleHandle = null;
  }
  if (state.maturityHandle) {
    try { clearInterval(state.maturityHandle); } catch { /* already cleared */ }
    state.maturityHandle = null;
  }
  if (state.heartbeatHandle) {
    try { clearInterval(state.heartbeatHandle); } catch { /* already cleared */ }
    state.heartbeatHandle = null;
  }

  // ── 1-minute rescore ─────────────────────────────────────────
  // Cron expression widened to '* * * * *' (every minute, 24×7) so the
  // Q365_REGEN_24X7 override actually takes effect — without this, the
  // outer cron schedule `* 9-15 * * 1-5` already skips outside market
  // hours regardless of what isInsideRescoreWindow returns.
  const rescoreCron = isRegenAlwaysOn() ? '*/5 * * * *' : '*/5 9-15 * * 1-5';
  state.rescoreTask = cron.schedule(rescoreCron, () => {
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
          kiteHits: r.kiteHits, yahooHits: r.yahooHits, // @deprecated marker
          failedFetches: r.failedFetches, elapsedMs: r.elapsedMs,
        });
      } catch (err: any) {
        log.error('[INPROC RESCORE] failed', { err: err?.message ?? String(err) });
      }
    })();
  }, { timezone: IST });

  // ── 10-minute intraday regeneration (default ON) ─────────────
  //
  // Full Phase 1-4 pipeline over ~2943 stocks is 60-120s of CPU +
  // Yahoo/Kite fetches + heavy DB writes per tick. Running that // @deprecated marker
  // inside the Next dev process is measurable but not fatal — and
  // without it the dashboard freezes on a stale batch (the "BUY 50
  // is static" symptom). Self-coalescing via regenInFlight +
  // hourlyScanInFlight stops back-to-back runs from overlapping,
  // and the rescore cron continues unblocked because it runs on a
  // separate cadence and shares no state with regen.
  //
  // Default: ENABLED in-process. Disable if you run the standalone
  // PM2 scheduler (workers/scheduler.ts) and don't want both
  // generating batches:
  //   Q365_INPROC_REGEN=0 npm run dev
  //
  // Rescore stays in-process always — it's cheap (a DB read + batch
  // live-price fetch + arithmetic + one chunked UPDATE), and it's
  // what makes the dashboard feel alive.
  const regenInProc = process.env.Q365_INPROC_REGEN !== '0';
  if (regenInProc) {
    // Same widening as the rescore cron when Q365_REGEN_24X7=1.
    const regenCron = isRegenAlwaysOn() ? '*/10 * * * *' : '*/10 9-15 * * 1-5';
    state.regenTask = cron.schedule(regenCron, () => {
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

  // ── Hourly FULL-MARKET scan (always on during NSE hours) ─────
  //
  // What it does: runs the same Phase 1-4 pipeline as runRegenInProc
  // (full universe ≈ 2943 symbols), top-of-hour during the NSE
  // session. This is the path that *discovers new signals*. Without
  // it, the dashboard freezes on whatever batch the engine last
  // produced — which is exactly the "BUY 50 static" symptom that
  // motivated this scheduler entry: rescore (every minute) keeps
  // existing rows scored against fresh ticks, but it never adds or
  // removes rows. Only a regen does that.
  //
  // Why hourly, not faster: a full Phase 1-4 over the universe is
  // 60-120s of CPU + Yahoo/Kite fetches per tick. At 10-min cadence // @deprecated marker
  // (the legacy regenTask) it eats a measurable fraction of the
  // event loop. Hourly is the right balance: a daytrader's edge
  // doesn't decay materially between top-of-hour boundaries, the
  // event loop stays responsive, and Yahoo's per-IP rate budget // @deprecated marker
  // isn't strained.
  //
  // Why a separate cron from regenTask: regenTask is opt-in
  // (Q365_INPROC_REGEN=1) and tuned for the operator who wants
  // 10-min cadence. This task is the new always-on default that
  // satisfies the "scan per hour when market is open" contract.
  // Both can coexist — they share self-coalescing on regenInFlight
  // so they never overlap.
  //
  // Cron: top of every hour 09-15 IST Mon-Fri. The `runHourlyMarket
  // ScanCheck` inner function gates on the more-precise 09:30-15:30
  // window, so the 09:00 firing actually fires at 10:00, the 15:00
  // firing fires (the last useful pass), and 16:00+ skip.
  const hourlyScanCron = isRegenAlwaysOn() ? '0 * * * *' : '0 9-15 * * 1-5';
  state.hourlyScanTask = cron.schedule(hourlyScanCron, () => {
    if (!isInsideRegenWindow()) return;
    if (state.hourlyScanInFlight || state.regenInFlight) {
      log.warn('[INPROC HOURLY-SCAN] regen still in flight — skipping');
      return;
    }
    state.hourlyScanInFlight = runRegenInProc()
      .catch((err) => log.error('[INPROC HOURLY-SCAN] failed', { err: err?.message ?? String(err) }))
      .finally(() => { state.hourlyScanInFlight = null; });
  }, { timezone: IST });

  // Cold-fire: if we boot during market hours, kick one scan after
  // 30s so the dashboard doesn't sit on whatever batch was in the DB
  // before this process started. 30s gives the rest of the boot
  // sequence (DB pool warmup, candle scheduler first tick) time to
  // settle before we spend ~90s of CPU on a regen.
  setTimeout(() => {
    if (!isInsideRegenWindow()) return;
    if (state.hourlyScanInFlight || state.regenInFlight) return;
    log.info('[INPROC HOURLY-SCAN] cold-fire on boot');
    state.hourlyScanInFlight = runRegenInProc()
      .catch((err) => log.error('[INPROC HOURLY-SCAN] cold-fire failed', { err: err?.message ?? String(err) }))
      .finally(() => { state.hourlyScanInFlight = null; });
  }, 30_000);

  // ── 15:30 IST market-close snapshot writer ──────────────────
  //
  // Cron `30 15 * * 1-5` (15:30 IST every weekday). Captures the
  // last-known live snapshot for every active-universe symbol into
  // q365_market_close_snapshot. The resolver's market-closed gate
  // reads this table whenever the in-memory cache misses (cold
  // process restart, evicted entries) so the off-hours UI never
  // shows DATA_DEGRADED for symbols that traded today.
  //
  // Self-coalescing via closeSnapshotInFlight — a slow run that
  // spans the next firing collapses into a single run.
  state.closeSnapshotTask = cron.schedule('30 15 * * 1-5', () => {
    if (state.closeSnapshotInFlight) {
      log.warn('[INPROC CLOSE-SNAPSHOT] previous run still in flight — skipping');
      return;
    }
    state.closeSnapshotInFlight = (async () => {
      try {
        const { runMarketCloseSnapshot } = await import(
          '@/lib/workers/marketCloseSnapshot'
        );
        const r = await runMarketCloseSnapshot();
        log.info('[INPROC CLOSE-SNAPSHOT] complete', {
          scanned: r.scanned, captured: r.captured, skipped: r.skipped,
          elapsedMs: r.elapsedMs, sessionDate: r.sessionDate,
        });
      } catch (err: any) {
        log.error('[INPROC CLOSE-SNAPSHOT] failed', { err: err?.message ?? String(err) });
      } finally {
        state.closeSnapshotInFlight = null;
      }
    })();
  }, { timezone: IST });

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

  // ── 30-second confirmed-snapshot lifecycle worker ────────────
  //
  // Walks ACTIVE rows in q365_confirmed_signal_snapshots and
  // transitions status based on price action / validity expiry. Uses
  // setInterval rather than node-cron because we need sub-minute
  // precision (cron's 5-field expression bottoms out at 1 min).
  //
  // Self-coalescing via snapshotLifecycleInFlight — a slow tick that
  // spans two firings collapses into a single run, no overlap.
  //
  // Runs 24x7 (no IST window). The work itself is cheap: when the
  // market is closed every active row's LTP is its last close, so
  // the only legitimate transitions are EXPIRED (validity elapsed)
  // — rare but real if a snapshot was confirmed at 14:30 with a 90-
  // min validity, it will EXPIRE at 16:00 IST, after market close.
  const SNAPSHOT_LIFECYCLE_INTERVAL_MS = 30_000;
  state.snapshotLifecycleHandle = setInterval(() => {
    if (state.snapshotLifecycleInFlight) return;
    state.snapshotLifecycleInFlight = (async () => {
      try {
        const { runConfirmedSnapshotLifecycle } = await import(
          '@/lib/cron/confirmedSnapshotLifecycle'
        );
        const r = await runConfirmedSnapshotLifecycle();
        if (r.scanned > 0 || r.expired > 0 || r.target_hit > 0
         || r.stop_loss_hit > 0 || r.invalidated > 0) {
          log.info('[INPROC SNAPSHOT-LIFECYCLE]', {
            scanned: r.scanned, expired: r.expired,
            target_hit: r.target_hit, stop_loss_hit: r.stop_loss_hit,
            invalidated: r.invalidated, unchanged: r.unchanged,
            failedFetches: r.failedFetches, elapsedMs: r.elapsedMs,
          });
        }
      } catch (err: any) {
        log.error('[INPROC SNAPSHOT-LIFECYCLE] failed', { err: err?.message ?? String(err) });
      } finally {
        state.snapshotLifecycleInFlight = null;
      }
    })();
  }, SNAPSHOT_LIFECYCLE_INTERVAL_MS);

  // ── 60-second signal-maturity worker ─────────────────────────
  //
  // Walks q365_signal_maturity_tracker, recomputes maturity from
  // the latest q365_signals row, persists score + stage, and
  // promotes mature rows into q365_confirmed_signal_snapshots
  // when cycles + age + score + stability all clear. THIS IS THE
  // ONLY PATH that creates confirmed snapshots — saveSignals only
  // upserts the tracker.
  const MATURITY_INTERVAL_MS = 60_000;
  state.maturityHandle = setInterval(() => {
    if (state.maturityInFlight) return;
    state.maturityInFlight = (async () => {
      try {
        const { runSignalMaturityWorker } = await import(
          '@/lib/cron/signalMaturity'
        );
        const r = await runSignalMaturityWorker();
        if (r.scanned > 0 || r.promoted > 0) {
          log.info('[INPROC MATURITY]', {
            scanned: r.scanned, promoted: r.promoted,
            matured: r.matured, developing: r.developing,
            candidate: r.candidate,
            regime_blocked: r.regime_blocked,
            failed: r.failed,
            elapsedMs: r.elapsedMs,
          });
        }
      } catch (err: any) {
        log.error('[INPROC MATURITY] failed', { err: err?.message ?? String(err) });
      } finally {
        state.maturityInFlight = null;
      }
    })();
  }, MATURITY_INTERVAL_MS);

  // ── 60-second pipeline heartbeat ─────────────────────────────
  //
  // Spec FIX-DATA-PIPELINE §4: the freshness probe in /api/signals
  // reads `scheduler:heartbeat:pipeline` from Redis and surfaces it
  // as `last_pipeline_run` whenever no confirmed snapshots exist.
  // Without this tick the dashboard shows `last_pipeline_run: null`
  // until the first confirmed signal lands — which can be hours away
  // on a fresh DB. Every successful runHeartbeatTier() call also runs
  // a cache-first batch refresh against the configured universe so
  // `quote:<SYMBOL>` cache cells stay warm for /api/signals readers.
  //
  // Cost: cache-first + budget-guarded. With QUOTE_TTL_S=60, the
  // second tick is essentially free — only cold cells incur an
  // upstream call. Self-coalescing via heartbeatInFlight so a slow
  // tick never overlaps the next firing.
  const HEARTBEAT_INTERVAL_MS = 60_000;
  state.heartbeatHandle = setInterval(() => {
    if (state.heartbeatInFlight) return;
    state.heartbeatInFlight = (async () => {
      try {
        const { runHeartbeatTier } = await import(
          '@/lib/marketData/providers/batchScheduler'
        );
        const r = await runHeartbeatTier();
        if (!r.ok) {
          log.warn('[INPROC HEARTBEAT] failed', { error: r.error });
        }
      } catch (err: any) {
        log.error('[INPROC HEARTBEAT] threw', { err: err?.message ?? String(err) });
      } finally {
        state.heartbeatInFlight = null;
      }
    })();
  }, HEARTBEAT_INTERVAL_MS);

  // Boot-fire once so the very first /api/signals poll sees a
  // populated `last_pipeline_run` instead of null.
  setTimeout(() => {
    if (state.heartbeatInFlight) return;
    state.heartbeatInFlight = (async () => {
      try {
        const { runHeartbeatTier } = await import(
          '@/lib/marketData/providers/batchScheduler'
        );
        await runHeartbeatTier();
      } catch (err: any) {
        log.warn('[INPROC HEARTBEAT] boot-fire failed', { err: err?.message ?? String(err) });
      } finally {
        state.heartbeatInFlight = null;
      }
    })();
  }, 2_000);

  state.bootedAt = Date.now();
  log.info('in-proc scheduler booted', {
    jobs: [
      '*/1 min rescore (09:20-15:30 IST)',
      'hourly full-market scan (09:30-15:30 IST, always on)',
      ...(regenInProc ? ['*/10 min regen (09:30-15:30 IST, default ON)'] : []),
      '15:30 IST market-close snapshot (Mon-Fri)',
      '*/5 min news ingestion (24x7)',
      '30s confirmed-snapshot lifecycle (24x7)',
      '60s signal-maturity worker (24x7)',
      '60s pipeline heartbeat (24x7)',
    ],
    regen_in_proc: regenInProc,
    hourly_scan:   true,
    regen_hint:    regenInProc
      ? '10-min regen ON (default). Set Q365_INPROC_REGEN=0 if you run the standalone PM2 scheduler.'
      : '10-min regen explicitly disabled via Q365_INPROC_REGEN=0. Hourly full-market scan is always on during NSE hours.',
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
  state.hourlyScanTask?.stop();
  state.newsTask?.stop();
  state.closeSnapshotTask?.stop();
  if (state.snapshotLifecycleHandle) clearInterval(state.snapshotLifecycleHandle);
  if (state.maturityHandle) clearInterval(state.maturityHandle);
  if (state.heartbeatHandle) clearInterval(state.heartbeatHandle);
  state.rescoreTask = null;
  state.regenTask = null;
  state.hourlyScanTask = null;
  state.newsTask = null;
  state.closeSnapshotTask = null;
  state.snapshotLifecycleHandle = null;
  state.maturityHandle = null;
  state.heartbeatHandle = null;
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
