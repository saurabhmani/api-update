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
  // Prevent silent process death on unhandled errors. Kite removal
  // took the ticker-restart path with it — crashes are now just
  // logged. Idempotent — guarded so HMR re-registration doesn't stack.
  if (!(globalThis as any).__Q365_CRASH_HOOKS__) {
    (globalThis as any).__Q365_CRASH_HOOKS__ = true;

    process.on('uncaughtException', (err) => {
      console.error(
        `[CRITICAL] uncaughtException — ${err?.message ?? err}\n${err?.stack ?? ''}`,
      );
      log.fatal('Uncaught exception', err);
    });

    process.on('unhandledRejection', (reason) => {
      const msg = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : '';
      console.error(`[CRITICAL] unhandledRejection — ${msg}\n${stack ?? ''}`);
      log.fatal(
        'Unhandled rejection',
        reason instanceof Error ? reason : { reason: String(reason) },
      );
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

  // Kite ticker + dynamic subscription sync + WebSocket stream
  // server were all removed with the Kite integration. Signal-only
  // mode serves from the Yahoo cache per request; no background
  // tick feed is required.
  log.info('Signal-only mode: Kite ticker / WS stream / sub-sync disabled');

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
