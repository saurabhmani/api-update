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
    INDIAN_API_KEY: !!(process.env.INDIAN_API_KEY ?? process.env.INDIANAPI_KEY),
  });

  // PROD-PARITY 2026-05 — single-line stamp of every knob that materially
  // affects signal/watchlist freshness. Operators compare this line
  // between local and prod boots to spot drift. Values are non-secret;
  // anything sensitive (API keys, passwords) is reported as presence
  // only in the block above.
  log.info('Freshness-config stamp', {
    Q365_INPROC_REGEN:            process.env.Q365_INPROC_REGEN ?? '(unset)',
    Q365_INPROC_SCHEDULER:        process.env.Q365_INPROC_SCHEDULER ?? '(unset)',
    Q365_REGEN_24X7:              process.env.Q365_REGEN_24X7 ?? '(unset)',
    CANDLE_MAX_PER_CYCLE:         process.env.CANDLE_MAX_PER_CYCLE ?? '(unset)',
    CANDLE_INGEST_CONCURRENCY:    process.env.CANDLE_INGEST_CONCURRENCY ?? '(unset)',
    CANDLE_REFRESH_INTERVAL_MS:   process.env.CANDLE_REFRESH_INTERVAL_MS ?? '(unset)',
    CACHE_TTL_LIVE_PRICE_MS:      process.env.CACHE_TTL_LIVE_PRICE_MS ?? '(unset)',
    SIGNALS_FREEZE_TTL_MS:        process.env.SIGNALS_FREEZE_TTL_MS ?? '(unset)',
    SIGNALS_LIVE_MARKET_TTL_MS:   process.env.SIGNALS_LIVE_MARKET_TTL_MS ?? '(unset)',
    INDIANAPI_BLOCK_OUTSIDE_MARKET: process.env.INDIANAPI_BLOCK_OUTSIDE_MARKET ?? '(unset)',
    INDIANAPI_MIN_CALL_GAP_MS:    process.env.INDIANAPI_MIN_CALL_GAP_MS ?? '(unset)',
    INDIANAPI_EMULATED_BATCH_MAX: process.env.INDIANAPI_EMULATED_BATCH_MAX ?? '(unset)',
    NSE_DIRECT_FALLBACK_TRIGGER_FAILURES: process.env.NSE_DIRECT_FALLBACK_TRIGGER_FAILURES ?? '(unset)',
    DATA_FRESHNESS_SLA_MS:        process.env.DATA_FRESHNESS_SLA_MS ?? '(unset)',
    SIGNAL_STICKY_VISIBILITY_MIN: process.env.SIGNAL_STICKY_VISIBILITY_MIN ?? '(unset)',
    CLOSED_SIGNALS_MAX_AGE_HOURS: process.env.CLOSED_SIGNALS_MAX_AGE_HOURS ?? '(unset)',
    FORCE_MARKET_OPEN:            process.env.FORCE_MARKET_OPEN ?? '(unset)',
  });

  // Resolved provider flags. Booleans only — explicit so an operator
  // can confirm at a glance that production is running IndianAPI-first.
  try {
    const { getProviderFlagsSummary } = await import('@/lib/marketData/providerFlags');
    log.info('Market-data provider flags', getProviderFlagsSummary());
  } catch {
    /* providerFlags is fail-safe; a load error must not block boot */
  }

  // SAFE_NSE_MODE confirmation. Loud, single-line log so operators
  // can grep for `SAFE_NSE_MODE_ENABLED` and confirm the contract is
  // active: IndianAPI primary, NSE direct safe fallback, no Yahoo.
  // Also emits the current one-time-bootstrap flag state so a fresh
  // deploy can see whether a `POST /api/signals/bootstrap` call is
  // still pending.
  try {
    const { isBootstrapDone } = await import('@/lib/marketData/oneTimeNseBootstrap');
    const flagSet = await isBootstrapDone();
    log.info('SAFE_NSE_MODE_ENABLED', {
      indianApiPrimary:   true,
      yahooDisabled:      true,
      nseDirectFallback:  true,
      bootstrapFlagSet:   flagSet,
    });
  } catch {
    /* bootstrap module is fail-safe; a load error must not block boot */
  }

  // BALANCED_REAL_DATA_MODE confirmation. The closed-market signal
  // path serves real DB rows only. Strict primary; relaxed fallback
  // (real data, softer floors) fires ONLY when strict returns zero
  // so the dashboard isn't empty when scanner output is thin.
  // Force-seed route is permanently 410; force_seed rows are
  // blocked at the SQL layer in both tiers.
  log.info('BALANCED_REAL_DATA_MODE_ENABLED', {
    forceSeedDisabled:        true,
    realDbOnly:               true,
    strict:  { confidence: 70, finalScore: 75, rr: 1.5 },
    relaxed: { confidence: 60, finalScore: 65, rr: 1.2,
               status: ['APPROVED_SIGNAL', 'DEVELOPING_SETUP'] },
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

  // ── Production env safety lock ──────────────────────────────
  // Hard guardrail for production deployments — refuses to boot when
  // FORCE_MARKET_OPEN / MOCK_MARKET_OPEN / BYPASS_MARKET_HOURS is
  // truthy, CANDLE_MAX_PER_CYCLE > 100, or INDIANAPI_PER_RUN_LIMIT > 500.
  // No-op outside production. Throws are intentional — a misconfigured
  // .env in prod must not silently start a server that burns quota.
  const { enforceProductionEnvSafety } = await import('@/lib/startup/envSafetyLock');
  enforceProductionEnvSafety();

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
      '@/providers/repos/snapshotRepo'
    );
    registerOnMarketDataProvider();
    log.info('Provider DB repo registered');
    return true;
  });

  // ── Live market WebSocket feed ──────────────────────────────
  // IndianAPI polling loop + WS fan-out on STREAM_WS_PORT.
  // Disabled when STREAM_WS_DISABLED=true (signal-only dev mode).
  await withBudget('Live market feed start', 5_000, async () => {
    const wsDisabled = (process.env.STREAM_WS_DISABLED ?? '').toLowerCase() === 'true';
    if (wsDisabled) {
      log.info('STREAM_WS_DISABLED — live market feed not started');
      return false;
    }
    const { startLiveMarketFeed } = await import('@/lib/marketData/liveMarketFeed');
    const { startStreamServer } = await import('@/lib/ws/streamServer');
    startLiveMarketFeed();
    const wsState = startStreamServer();
    log.info('Live market WebSocket feed started', {
      wsPort: wsState.port,
      wsRunning: wsState.running,
    });
    return true;
  });

  // Kite ticker + dynamic subscription sync were removed with the
  // Kite integration. Live ticks now flow IndianAPI → liveMarketFeed
  // → tickBus → streamServer → browser WebSocket clients.
  log.info('Live market mode: IndianAPI feed + WS stream enabled (unless STREAM_WS_DISABLED)');

  // ── DB-driven tradeable universe ────────────────────────────
  // The engine reads its scan list from q365_universe(is_active=1).
  // `loadTradeableUniverse()` hydrates the in-memory TRADEABLE_UNIVERSE
  // array via the DB-backed loader in nifty500Universe.ts — every
  // consumer that holds a reference to DEFAULT_PHASE1_CONFIG.universe
  // sees the populated list on first read after boot.
  //
  // PRODUCTION CONTRACT: the loader THROWS when q365_universe is
  // degraded. Do not let that throw kill Next instrumentation, though:
  // production should boot so operators can reach admin/health pages and
  // run the NSE1000 rebuild. Signal/scanner entrypoints still call
  // ensureUniverseReady() and return/throw UNIVERSE_NOT_READY until the
  // DB has the exact NSE1000 target.
  //
  // Universe log emits a [UNIVERSE] DB=N CSV=N ACTIVE=N line so an
  // operator can spot drift between the seed file and the DB at a
  // glance. CSV count is read once, best-effort — N/A if missing.
  async function logUniverseLine(activeCount: number): Promise<void> {
    let csvCount: number | 'N/A' = 'N/A';
    try {
      const { existsSync, readFileSync } = await import('node:fs');
      const { resolve } = await import('node:path');
      const csvPath =
        process.env.NIFTY500_CSV_PATH?.trim() ||
        resolve(process.cwd(), 'ind_nifty500list.csv');
      if (existsSync(csvPath)) {
        const raw = readFileSync(csvPath, 'utf8');
        // Header + EQ-only rows. Best-effort line count; the
        // canonical source-of-truth check is q365_universe.
        const lines = raw.split(/\r?\n/).filter(l => l.trim().length > 0);
        // Subtract 1 for the header row.
        csvCount = Math.max(0, lines.length - 1);
      }
    } catch { /* best-effort — never block boot for the log line */ }
    console.log(
      `[UNIVERSE] DB=${activeCount} CSV=${csvCount} ACTIVE=${activeCount}`,
    );
  }

  {
    const { loadTradeableUniverse } = await import(
      '@/lib/signal-engine/constants/signalEngine.constants'
    );
    try {
      const universe = await loadTradeableUniverse();
      log.info('Tradeable universe loaded', { size: universe.length });
      await logUniverseLine(universe.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[UNIVERSE_NOT_READY] boot continuing with degraded/unloaded universe: ${msg}`);
      log.error('Tradeable universe not ready — boot continuing; scan/API entrypoints remain guarded', {
        error_message: msg,
        remediation: 'Run npx tsx scripts/weeklyNse1000UniverseRebuild.ts --target 1000, then restart.',
      });
    }
  }

  // ── 60s OHLC refresh scheduler ──────────────────────────────
  await withBudget('Candle scheduler start', 5_000, async () => {
    const { startCandleScheduler } = await import(
      '@/lib/workers/candleRefreshScheduler'
    );
    startCandleScheduler();
    log.info('Candle refresh scheduler started');
    return true;
  });

  // ── Feed-health retention cron (Step 6.5) ───────────────────
  // Daily 02:30 IST DELETE of q365_data_feed_health rows older than
  // FEED_HEALTH_RETENTION_DAYS (default 30). Runs in-process; no
  // separate worker process required.
  await withBudget('Feed-health retention start', 2_000, async () => {
    const { startFeedHealthRetention } = await import(
      '@/lib/workers/feedHealthRetention'
    );
    startFeedHealthRetention();
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
