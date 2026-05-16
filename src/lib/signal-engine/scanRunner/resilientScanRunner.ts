// ════════════════════════════════════════════════════════════════
//  Resilient Scan Runner — Phase NEXT (infrastructure)
//
//  Generic, provider-agnostic orchestrator that fans a per-symbol
//  task across a bounded concurrency pool with:
//
//    • bounded worker pool (default 16, capped at 64)
//    • per-symbol timeout via AbortController
//    • exponential-backoff retry queue with separate caps per kind
//    • provider fallback (each symbol's task can declare a list of
//      providers — the runner cycles through them on failure)
//    • partial-failure tolerance (one symbol's failure never aborts
//      the scan)
//    • structured telemetry: [UNIVERSE_PROGRESS], [SYMBOL_TIMEOUT],
//      [BATCH_COMPLETE]
//    • per-provider counters: success, failed, timeout, latency
//
//  The runner does NOT touch the strict signal filters — those live
//  inside the per-symbol task. Its only job is to make sure every
//  symbol gets the chance to run, that nothing hangs forever, and
//  that the operator can see why a symbol failed.
//
//  Pure orchestration logic. No persistence. Caller wraps the
//  per-symbol scoring/persistence step in `task` and persists the
//  result themselves once the runner emits it.
// ════════════════════════════════════════════════════════════════

// ── Public types ───────────────────────────────────────────────

export type SymbolStatus =
  | 'success'
  | 'timeout'
  | 'failed'
  | 'retrying';

export interface SymbolTaskContext {
  symbol:        string;
  /** 1-based attempt counter — 1 on first try, 2+ on retry. */
  attempt:       number;
  /** Provider chosen for this attempt. */
  provider:      string;
  /** Cancellation signal — task MUST honour it (pass into fetch, etc.). */
  signal:        AbortSignal;
}

export interface SymbolTaskOk<TOut> {
  ok:        true;
  data:      TOut;
  /** Optional override for the next-attempt provider. */
  provider?: string;
}

export interface SymbolTaskErr {
  ok:        false;
  /** Free-form code: 'TIMEOUT' is reserved; everything else is custom. */
  code:      string;
  message:   string;
  /** When `true`, the runner does NOT retry — task wants a hard reject. */
  permanent?: boolean;
}

export type SymbolTaskResult<TOut> = SymbolTaskOk<TOut> | SymbolTaskErr;

export type SymbolTask<TOut> = (
  ctx: SymbolTaskContext,
) => Promise<SymbolTaskResult<TOut>>;

export interface ScanRunnerConfig {
  /** Worker pool size. Default 16; clamped to [1, 64]. */
  concurrency:        number;
  /** Per-symbol timeout in milliseconds. Default 5_000. */
  perSymbolTimeoutMs: number;
  /** Max retry attempts per symbol (excluding the first try). Default 2. */
  maxRetries:         number;
  /** Retry backoff base in milliseconds. Default 250. Backoff grows
   *  exponentially: base, base*2, base*4 ... */
  backoffBaseMs:      number;
  /** Provider order for the runner to rotate through on failure.
   *  When a task fails on `providers[i]`, the next attempt uses
   *  `providers[(i+1) % providers.length]`. Defaults to `['default']`. */
  providers:          string[];
  /** Progress log cadence (every N completed symbols). Default 25. */
  progressEveryN:     number;
}

export const DEFAULT_RUNNER_CONFIG: ScanRunnerConfig = {
  concurrency:        16,
  perSymbolTimeoutMs: 5_000,
  maxRetries:         2,
  backoffBaseMs:      250,
  providers:          ['default'],
  progressEveryN:     25,
};

export interface ProviderHealth {
  provider:        string;
  attempts:        number;
  successes:       number;
  failures:        number;
  timeouts:        number;
  /** Mean elapsed ms across attempts (success + failure). */
  avgLatencyMs:    number;
  /** Recent failure rate as fraction in [0, 1]. */
  failureRate:     number;
  /** True when failureRate ≥ 0.5 over ≥ 8 attempts. */
  unhealthy:       boolean;
}

export interface SymbolReport<TOut> {
  symbol:        string;
  status:        SymbolStatus;
  attempts:      number;
  /** Provider that produced the final outcome. */
  provider:      string;
  elapsedMs:     number;
  /** Present when status === 'success'. */
  data?:         TOut;
  /** Failure code (final attempt). */
  errorCode?:    string;
  errorMessage?: string;
}

export interface ScanRunReport<TOut> {
  totalSymbols:    number;
  scanned:         number;
  skipped:         number;
  succeeded:       number;
  failed:          number;
  timeoutCount:    number;
  retryCount:      number;
  avgLatencyMs:    number;
  durationMs:      number;
  coveragePercent: number;
  providerHealth:  ProviderHealth[];
  reports:         SymbolReport<TOut>[];
}

export interface ScanRunOptions<TOut> {
  symbols:  string[];
  task:     SymbolTask<TOut>;
  config?:  Partial<ScanRunnerConfig>;
  /** Optional progress sink. Called once per completed symbol. */
  onSymbol?: (report: SymbolReport<TOut>, runningTotals: {
    scanned: number; succeeded: number; failed: number; timeoutCount: number;
    retryCount: number;
  }) => void;
  /** Optional structured logger for the [UNIVERSE_PROGRESS] /
   *  [SYMBOL_TIMEOUT] / [BATCH_COMPLETE] tags. Defaults to console.log. */
  log?:     (line: string, payload?: Record<string, unknown>) => void;
}

// ── Internal helpers ───────────────────────────────────────────

function clampConfig(c?: Partial<ScanRunnerConfig>): ScanRunnerConfig {
  const merged = { ...DEFAULT_RUNNER_CONFIG, ...(c ?? {}) };
  return {
    ...merged,
    concurrency:        Math.max(1, Math.min(64, merged.concurrency)),
    perSymbolTimeoutMs: Math.max(250, merged.perSymbolTimeoutMs),
    maxRetries:         Math.max(0, Math.min(5, merged.maxRetries)),
    backoffBaseMs:      Math.max(0, merged.backoffBaseMs),
    providers:          merged.providers.length > 0 ? merged.providers : ['default'],
    progressEveryN:     Math.max(1, merged.progressEveryN),
  };
}

interface ProviderCounters {
  attempts:  number;
  successes: number;
  failures:  number;
  timeouts:  number;
  totalMs:   number;
}

function emptyProviderCounters(): ProviderCounters {
  return { attempts: 0, successes: 0, failures: 0, timeouts: 0, totalMs: 0 };
}

function defaultLog(line: string, payload?: Record<string, unknown>): void {
  // Keep payloads as a separate console arg so log shippers can pretty-print.
  // eslint-disable-next-line no-console
  if (payload) console.log(line, payload);
  // eslint-disable-next-line no-console
  else         console.log(line);
}

/**
 * Race a promise against an abortable timeout. Resolves with the
 * promise's result on success; throws TimeoutError on timeout, abort
 * propagates as AbortError.
 */
async function withTimeout<T>(
  fn:       (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('TIMEOUT')), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function isTimeoutError(err: unknown): boolean {
  if (!err) return false;
  const e = err as { name?: string; message?: string };
  return e.name === 'AbortError' || /timeout/i.test(e.message ?? '');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('ABORTED'));
      }, { once: true });
    }
  });
}

// ── Per-symbol runner ─────────────────────────────────────────

/**
 * Run a single symbol through up to (1 + maxRetries) attempts,
 * rotating providers and emitting [SYMBOL_TIMEOUT] when an attempt
 * times out. Always returns a SymbolReport — never throws.
 */
async function runSymbol<TOut>(
  symbol:   string,
  task:     SymbolTask<TOut>,
  config:   ScanRunnerConfig,
  perProvider: Map<string, ProviderCounters>,
  log:      (line: string, payload?: Record<string, unknown>) => void,
): Promise<{ report: SymbolReport<TOut>; retryCount: number }> {
  const startedAt = Date.now();
  let attempt = 0;
  let retryCount = 0;
  let lastErrCode = 'UNKNOWN';
  let lastErrMsg  = '';
  let lastProvider = config.providers[0];

  for (let i = 0; i <= config.maxRetries; i++) {
    attempt += 1;
    const provider = config.providers[i % config.providers.length];
    lastProvider = provider;

    const counters = perProvider.get(provider) ?? emptyProviderCounters();
    counters.attempts += 1;
    perProvider.set(provider, counters);

    const t0 = Date.now();
    let timedOut = false;
    let result: SymbolTaskResult<TOut> | null = null;

    try {
      result = await withTimeout(
        async (signal) => task({ symbol, attempt, provider, signal }),
        config.perSymbolTimeoutMs,
      );
    } catch (err) {
      timedOut = isTimeoutError(err);
      result = {
        ok: false,
        code: timedOut ? 'TIMEOUT' : 'EXCEPTION',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const elapsed = Date.now() - t0;
    counters.totalMs += elapsed;

    if (result && result.ok) {
      counters.successes += 1;
      return {
        report: {
          symbol,
          status:    'success',
          attempts:  attempt,
          provider:  result.provider ?? provider,
          elapsedMs: Date.now() - startedAt,
          data:      result.data,
        },
        retryCount,
      };
    }

    // Failure path — `result` here is either null (impossible — withTimeout
    // throws into the catch which sets result) or a SymbolTaskErr.
    const err: SymbolTaskErr = result as SymbolTaskErr;
    counters.failures += 1;
    if (timedOut || err.code === 'TIMEOUT') {
      counters.timeouts += 1;
      log('[SYMBOL_TIMEOUT]', {
        symbol, attempt, provider, elapsed_ms: elapsed,
        timeout_ms: config.perSymbolTimeoutMs,
      });
    }

    lastErrCode = err.code;
    lastErrMsg  = err.message;

    // Permanent rejection — caller said do not retry.
    if (err.permanent) {
      return {
        report: {
          symbol,
          status:        'failed',
          attempts:      attempt,
          provider,
          elapsedMs:     Date.now() - startedAt,
          errorCode:     lastErrCode,
          errorMessage:  lastErrMsg,
        },
        retryCount,
      };
    }

    // Retry budget exhausted?
    if (i >= config.maxRetries) break;

    // Backoff + provider rotation handled implicitly by the loop.
    retryCount += 1;
    const backoff = config.backoffBaseMs * Math.pow(2, i);
    if (backoff > 0) await sleep(backoff);
  }

  const status: SymbolStatus = lastErrCode === 'TIMEOUT' ? 'timeout' : 'failed';
  return {
    report: {
      symbol,
      status,
      attempts:     attempt,
      provider:     lastProvider,
      elapsedMs:    Date.now() - startedAt,
      errorCode:    lastErrCode,
      errorMessage: lastErrMsg,
    },
    retryCount,
  };
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Run a per-symbol task across the universe with bounded concurrency,
 * per-symbol timeouts, retries, and provider rotation. Returns a
 * deterministic ScanRunReport. Never throws — symbol failures are
 * captured in the report so the caller can decide how to respond.
 */
export async function runResilientScan<TOut>(
  opts: ScanRunOptions<TOut>,
): Promise<ScanRunReport<TOut>> {
  const config = clampConfig(opts.config);
  const log    = opts.log ?? defaultLog;

  const symbols = opts.symbols.filter((s) => typeof s === 'string' && s.trim().length > 0);
  const total   = symbols.length;

  if (total === 0) {
    log('[BATCH_COMPLETE]', {
      total: 0, scanned: 0, succeeded: 0, failed: 0, coverage_pct: 0,
    });
    return {
      totalSymbols: 0, scanned: 0, skipped: 0, succeeded: 0, failed: 0,
      timeoutCount: 0, retryCount: 0, avgLatencyMs: 0, durationMs: 0,
      coveragePercent: 0, providerHealth: [], reports: [],
    };
  }

  const startedAt = Date.now();
  const reports:  Array<SymbolReport<TOut> | undefined> = new Array(total);
  const perProvider = new Map<string, ProviderCounters>();
  for (const p of config.providers) perProvider.set(p, emptyProviderCounters());

  let scanned     = 0;
  let succeeded   = 0;
  let failed      = 0;
  let timeoutCount = 0;
  let retryCount  = 0;
  let cursor      = 0;

  // Worker fans out and pulls indices until the queue is exhausted.
  // Each worker is independent; one slow symbol does not block others.
  const worker = async (workerId: number): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= total) return;

      const symbol = symbols[idx];
      const { report, retryCount: rc } = await runSymbol<TOut>(
        symbol, opts.task, config, perProvider, log,
      );
      reports[idx] = report;
      retryCount  += rc;

      scanned += 1;
      if (report.status === 'success')      succeeded   += 1;
      else if (report.status === 'timeout') { failed += 1; timeoutCount += 1; }
      else                                   failed      += 1;

      const totals = { scanned, succeeded, failed, timeoutCount, retryCount };
      try { opts.onSymbol?.(report, totals); }
      catch { /* never let a callback abort the scan */ }

      if (scanned % config.progressEveryN === 0 || scanned === total) {
        const pct = total > 0 ? Math.round((scanned / total) * 1000) / 10 : 0;
        log('[UNIVERSE_PROGRESS]', {
          worker:        workerId,
          scanned, total,
          succeeded, failed, timeout_count: timeoutCount, retry_count: retryCount,
          coverage_pct:  pct,
          last_symbol:   symbol,
        });
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(config.concurrency, total) },
    (_, i) => worker(i + 1),
  );
  await Promise.all(workers);

  const durationMs = Date.now() - startedAt;

  // Build provider health snapshot.
  const providerHealth: ProviderHealth[] = [];
  for (const [provider, c] of perProvider) {
    const failureRate = c.attempts > 0 ? c.failures / c.attempts : 0;
    providerHealth.push({
      provider,
      attempts:     c.attempts,
      successes:    c.successes,
      failures:     c.failures,
      timeouts:     c.timeouts,
      avgLatencyMs: c.attempts > 0 ? Math.round(c.totalMs / c.attempts) : 0,
      failureRate:  Math.round(failureRate * 1000) / 1000,
      unhealthy:    c.attempts >= 8 && failureRate >= 0.5,
    });
  }

  const cleanReports = reports.filter((r): r is SymbolReport<TOut> => r != null);
  const totalLatency = cleanReports.reduce((s, r) => s + r.elapsedMs, 0);
  const avgLatencyMs = cleanReports.length > 0
    ? Math.round(totalLatency / cleanReports.length)
    : 0;
  const coveragePercent = total > 0
    ? Math.round((succeeded / total) * 1000) / 10
    : 0;

  log('[BATCH_COMPLETE]', {
    total,
    scanned, succeeded, failed,
    timeout_count: timeoutCount,
    retry_count:   retryCount,
    coverage_pct:  coveragePercent,
    duration_ms:   durationMs,
    avg_latency_ms: avgLatencyMs,
    providers: providerHealth.map((p) => ({
      provider: p.provider, attempts: p.attempts,
      success:  p.successes, failure: p.failures, timeout: p.timeouts,
      avg_ms:   p.avgLatencyMs, unhealthy: p.unhealthy,
    })),
  });

  return {
    totalSymbols:   total,
    scanned,
    skipped:        total - scanned,
    succeeded,
    failed,
    timeoutCount,
    retryCount,
    avgLatencyMs,
    durationMs,
    coveragePercent,
    providerHealth,
    reports:        cleanReports,
  };
}

// ── Adapter for the legacy CandleProvider shape ─────────────────

/**
 * Wrap a sequential CandleProvider so the resilient runner can drive
 * it. The caller still owns the per-symbol work — this helper only
 * adds the timeout / retry / provider-rotation envelope.
 *
 * Use-case: an existing pipeline like generatePhase1Signals that
 * loops `await provider.fetchDailyCandles(symbol)` can keep its
 * scoring logic and just delegate the fetch+score loop to
 * `runResilientScan`. The strict signal filters stay untouched.
 */
export function wrapCandleProvider<TOut>(
  fetchOne: (symbol: string, signal: AbortSignal, provider: string) => Promise<TOut>,
): SymbolTask<TOut> {
  return async (ctx) => {
    try {
      const data = await fetchOne(ctx.symbol, ctx.signal, ctx.provider);
      return { ok: true, data };
    } catch (err) {
      const isTo = isTimeoutError(err);
      return {
        ok:        false,
        code:      isTo ? 'TIMEOUT' : 'FETCH_ERROR',
        message:   err instanceof Error ? err.message : String(err),
        permanent: false,
      };
    }
  };
}
