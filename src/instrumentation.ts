// ════════════════════════════════════════════════════════════════
//  Next.js Instrumentation — Runs once at app startup
//
//  - Validates environment variables
//  - Registers global crash handlers
//  - Starts background services (stream server, candle scheduler)
//  - All output via structured logger — no console.log
// ════════════════════════════════════════════════════════════════

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { logger } = await import('@/lib/logger');
  const log = logger.child({ component: 'boot' });

  // ── Global crash handlers ───────────────────────────────────
  // Prevent silent process death on unhandled errors. Every crash
  // emits a [CRITICAL] line (grep target for alerting) and, when
  // the error touched the tick path, attempts to re-boot the Kite
  // ticker in-process so a transient bug doesn't sideline the feed
  // until the next manual restart.
  //
  // Idempotent — guarded so HMR re-registration doesn't stack.
  if (!(globalThis as any).__Q365_CRASH_HOOKS__) {
    (globalThis as any).__Q365_CRASH_HOOKS__ = true;

    // Coalesce rapid-fire restart attempts — if the crash cascade
    // is firing every frame, we don't want 1000 bootTicker calls.
    let lastRestartAt = 0;
    const RESTART_COOLDOWN_MS = 10_000;

    async function safeRestartTicker(tag: string, reason: string): Promise<void> {
      const now = Date.now();
      if (now - lastRestartAt < RESTART_COOLDOWN_MS) {
        console.error(
          `[CRITICAL] ${tag} restart skipped — cooldown ` +
          `(${Math.round((RESTART_COOLDOWN_MS - (now - lastRestartAt)) / 1000)}s remaining)`,
        );
        return;
      }
      lastRestartAt = now;
      console.error(`[CRITICAL] ${tag} crash detected → restarting ticker  reason=${reason}`);
      try {
        const { bootTickerSafe } = await import('@/lib/marketData/bootTicker');
        // Force re-boot by clearing the idempotency flag. bootTickerSafe
        // respects the global flag to avoid double-booting during normal
        // HMR; on a crash path we explicitly want it to run again.
        (globalThis as any).__q365_ticker_booted__ = undefined;
        const result = await bootTickerSafe();
        if ('booted' in result && result.booted) {
          console.log(`[CRITICAL] ticker restart OK  universe=${result.universeSize}`);
        } else if ('error' in result) {
          console.error(`[CRITICAL] ticker restart failed — ${result.error}`);
        }
      } catch (err: any) {
        console.error(`[CRITICAL] ticker restart threw — ${err?.message ?? err}`);
      }
    }

    process.on('uncaughtException', (err) => {
      console.error(
        `[CRITICAL] uncaughtException — ${err?.message ?? err}\n${err?.stack ?? ''}`,
      );
      log.fatal('Uncaught exception', err);
      void safeRestartTicker('uncaughtException', err?.message ?? 'unknown');
    });

    process.on('unhandledRejection', (reason) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : '';
      console.error(`[CRITICAL] unhandledRejection — ${msg}\n${stack ?? ''}`);
      log.fatal(
        'Unhandled rejection',
        reason instanceof Error ? reason : { reason: String(reason) },
      );
      void safeRestartTicker('unhandledRejection', msg);
    });
  }

  // ── Boot env visibility ─────────────────────────────────────
  // Print presence (true/false), never values — secrets stay out.
  log.info('Environment check', {
    NODE_ENV: process.env.NODE_ENV ?? 'unknown',
    DATABASE_URL: !!process.env.DATABASE_URL,
    MYSQL_HOST: !!process.env.MYSQL_HOST,
    SESSION_SECRET: !!process.env.SESSION_SECRET,
    REDIS_HOST: !!process.env.REDIS_HOST,
  });

  // Env validation: log missing vars but NEVER throw from the
  // instrumentation hook. Throwing kills the entire Next server boot.
  const { ensureEnv } = await import('@/lib/validateEnv');
  try {
    ensureEnv();
    log.info('Environment validation passed');
  } catch (err) {
    log.error('Environment validation failed — server will boot but requests may fail', err instanceof Error ? err : new Error(String(err)));
  }

  // ── Hard-timeout wrapper for boot steps ────────────────────────
  // Prevents a stuck DB connection, WebSocket handshake, or hanging
  // DDL from blocking the HTTP server boot indefinitely. Each step
  // gets a budget; exceed it and we log + continue. Background work
  // the step was doing keeps running — we just stop awaiting.
  async function withBudget<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T | null> {
    const start = Date.now();
    let done = false;
    const timer = new Promise<null>((resolve) => {
      setTimeout(() => {
        if (!done) {
          console.error(`[boot] ⚠ ${label} exceeded ${ms}ms budget — continuing without awaiting`);
          resolve(null);
        }
      }, ms);
    });
    try {
      const result = await Promise.race([fn(), timer]);
      done = true;
      const took = Date.now() - start;
      if (result !== null) log.info(`${label} completed`, { took_ms: took });
      return result;
    } catch (err) {
      done = true;
      log.warn(`${label} threw`, err instanceof Error ? { error_message: err.message } : { error_raw: String(err) });
      return null;
    }
  }

  // ── Schema ensure (both layers, in parallel) ────────────────
  // Runs BOTH ensureAllSchemas (core users/portfolio/q365_* DDL) and
  // ensureSignalEngineSchemas (Phase 3/4 audit tables + q365_signals
  // additive column migration + market_data_daily VIEW) at boot, so
  // every table a route handler might touch exists before the first
  // request lands.
  //
  // Without this, the first /api/signals request on a DB that predates
  // Phase 3 throws "Unknown column 's.portfolio_fit_score'", which
  // Next.js 14 surfaces as a generic `reading 'bind'` crash. Calling
  // both ensures here — combined with the `failed === 0` cache gate
  // in ensureAllSchemas — means a transient boot flake no longer
  // permanently poisons the schema cache.
  await withBudget('Schemas ensure', 20_000, async () => {
    const { ensureSchemasSafely } = await import('@/lib/db/ensureSchemasSafely');
    const result = await ensureSchemasSafely();
    log.info('Schemas ensured', {
      core_ok:         result.coreOk,
      signal_engine_ok: result.signalEngineOk,
      core_error:         result.coreError ?? null,
      signal_engine_error: result.signalEngineError ?? null,
    });
    return result;
  });

  // ── MarketDataProvider DB repo registration ─────────────────
  // Wires the snapshot repo (stale-last-resort DB fallback) into the
  // MarketDataProvider. Without this, every request that falls through
  // IndianAPI → cache → Yahoo also fails at the DB step with
  // "db repo not registered" — drowns the log and loses the fallback.
  await withBudget('Provider DB repo register', 3_000, async () => {
    const { registerOnMarketDataProvider } = await import(
      '@/services/repos/snapshotRepo'
    );
    registerOnMarketDataProvider();
    log.info('Provider DB repo registered');
    return true;
  });

  // ── Kite ticker boot (subscribes universe → ticks flow) ─────
  // MUST run before startStreamServer() so the tickBus has frames
  // ready (or is actively producing) by the time the fan-out
  // server wires its listener. bootTicker loads the universe,
  // seeds the symbol↔token map from nseUniverse.json, subscribes
  // after the socket opens, and is idempotent against HMR.
  await withBudget('Kite ticker boot', 15_000, async () => {
    const { bootTickerSafe } = await import('@/lib/marketData/bootTicker');
    const result = await bootTickerSafe();
    if ('booted' in result && result.booted) {
      log.info('Kite ticker booted', { universeSize: result.universeSize, mode: result.mode });
    } else if ('alreadyBooted' in result && (result as { alreadyBooted?: boolean }).alreadyBooted) {
      log.info('Kite ticker already booted');
    } else if ('error' in result) {
      console.error(`[ERROR] bootTicker not executed — ${result.error}`);
      log.warn('Kite ticker boot deferred', { error: result.error });
    }
    return result;
  });

  // ── Dynamic subscription sync ───────────────────────────────
  // Drives a narrow, active-signals-only Kite subscription (target
  // 50–200 tokens) instead of a blanket 2700-symbol fan-out. Runs
  // on an interval so freshly-generated signals hit the live feed
  // within one cycle.
  await withBudget('Dynamic subscription sync start', 5_000, async () => {
    const { startDynamicSubscriptionSync } = await import(
      '@/lib/marketData/dynamicSubscriptionSync'
    );
    startDynamicSubscriptionSync();
    log.info('Dynamic subscription sync started');
    return true;
  });

  // ── Real-time price stream (WebSocket fan-out) ──────────────
  // Started AFTER bootTicker so the tickBus is already wired to
  // the Kite socket; any tick that arrives during the wss handshake
  // is captured rather than lost.
  await withBudget('Stream server start', 5_000, async () => {
    const { startStreamServer } = await import('@/lib/ws/streamServer');
    startStreamServer();
    log.info('Stream server started');
    return true;
  });

  // ── 60s OHLC refresh scheduler ──────────────────────────────
  await withBudget('Candle scheduler start', 5_000, async () => {
    const { startCandleScheduler } = await import(
      '@/lib/workers/candleRefreshScheduler'
    );
    startCandleScheduler();
    log.info('Candle refresh scheduler started');
    return true;
  });

  // ── In-process scheduler (dev mode) ─────────────────────────
  // Boots the 1-min rescore + 10-min regen crons inside the Next
  // runtime so `npm run dev` gets the same rotation behaviour as
  // prod without requiring a separate PM2 scheduler process.
  //
  // Self-gated: bootInProcScheduler() returns a no-op in prod
  // (NODE_ENV !== 'development') unless Q365_INPROC_SCHEDULER=1
  // is set explicitly. Safe to call unconditionally.
  await withBudget('In-proc scheduler start', 5_000, async () => {
    const { bootInProcScheduler } = await import('@/lib/workers/bootInProc');
    bootInProcScheduler();
    return true;
  });

  log.info('Boot sequence complete');
}
