// ════════════════════════════════════════════════════════════════
//  Structured Logger — JSON output, leveled, context-aware
//
//  Usage:
//    import { logger } from '@/lib/logger';
//    logger.info('Server started', { port: 3000 });
//    const log = logger.child({ service: 'signalEngine' });
//    log.warn('Slow query', { durationMs: 1200 });
//
//  Output (one JSON object per line):
//    {"level":"info","ts":"2026-04-16T10:00:00.000Z","msg":"Server started","port":3000}
//
//  Levels: debug < info < warn < error < fatal
//  Default level: 'info' (override via LOG_LEVEL env var)
// ════════════════════════════════════════════════════════════════

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

interface LogEntry {
  level: LogLevel;
  ts: string;
  msg: string;
  [key: string]: unknown;
}

type LogContext = Record<string, unknown>;

function getMinLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL ?? 'info').toLowerCase() as LogLevel;
  return LEVEL_ORDER[env] !== undefined ? env : 'info';
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[getMinLevel()];
}

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      error_name: err.name,
      error_message: err.message,
      error_stack: err.stack,
    };
  }
  return { error_raw: String(err) };
}

function emit(level: LogLevel, msg: string, ctx: LogContext): void {
  if (!shouldLog(level)) return;

  const entry: LogEntry = {
    level,
    ts: new Date().toISOString(),
    msg,
    ...ctx,
  };

  const line = JSON.stringify(entry);

  // Use stderr for error/fatal so stdout stays clean for structured data
  if (level === 'error' || level === 'fatal') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

// ── Dedup / rate-limit cache ────────────────────────────────────
// LOG-FLOODING-FIX (2026-05) — providers / pollers can fire the same
// warning every tick (e.g. "Yahoo batch slow", "universe not ready",
// "tracker maturity X < 40"). The dedup window collapses repeats to
// a single line per (level, msg, key) per LOG_DEDUP_WINDOW_MS, with
// a tail count so operators still see how loud the source was.
// Default 60s; tuneable via LOG_DEDUP_WINDOW_MS env. Window=0 disables.
const dedupWindowMs = (() => {
  const raw = Number(process.env.LOG_DEDUP_WINDOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000;
})();
const DEDUP_MAX_KEYS = 4_096;
const dedupCache: Map<string, { lastEmit: number; suppressed: number }> = new Map();

function dedupAllow(level: LogLevel, msg: string, key: string): boolean {
  if (dedupWindowMs === 0) return true;
  const cacheKey = `${level}::${msg}::${key}`;
  const now = Date.now();
  const cached = dedupCache.get(cacheKey);
  if (cached && now - cached.lastEmit < dedupWindowMs) {
    cached.suppressed += 1;
    return false;
  }
  // Bound the map size; drop a random entry if we hit the cap.
  if (!cached && dedupCache.size >= DEDUP_MAX_KEYS) {
    const firstKey = dedupCache.keys().next().value;
    if (firstKey !== undefined) dedupCache.delete(firstKey);
  }
  const suppressed = cached?.suppressed ?? 0;
  dedupCache.set(cacheKey, { lastEmit: now, suppressed: 0 });
  if (suppressed > 0) {
    // Attach the prior-window suppression count on the next emit.
    emit('info', '[LOG_DEDUP]', {
      level, msg_key: cacheKey, suppressed_in_prior_window: suppressed,
      window_ms: dedupWindowMs,
    });
  }
  return true;
}

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, errOrCtx?: Error | LogContext, ctx?: LogContext): void;
  fatal(msg: string, errOrCtx?: Error | LogContext, ctx?: LogContext): void;
  child(defaultCtx: LogContext): Logger;
  /** LOG-FLOODING-FIX (2026-05) — emit at `level` only if the same
   *  (msg, key) pair has not been emitted in the dedup window. The
   *  `key` is normally the deduplication discriminator (provider name,
   *  symbol, error code) — leave empty for plain "log once per window". */
  rateLimited(level: LogLevel, msg: string, key: string, ctx?: LogContext): void;
}

function createLogger(defaultCtx: LogContext = {}): Logger {
  function mergeErrorCtx(
    errOrCtx?: Error | LogContext,
    ctx?: LogContext,
  ): LogContext {
    if (errOrCtx instanceof Error) {
      return { ...defaultCtx, ...serializeError(errOrCtx), ...ctx };
    }
    return { ...defaultCtx, ...errOrCtx };
  }

  return {
    debug(msg: string, ctx?: LogContext) {
      emit('debug', msg, { ...defaultCtx, ...ctx });
    },

    info(msg: string, ctx?: LogContext) {
      emit('info', msg, { ...defaultCtx, ...ctx });
    },

    warn(msg: string, ctx?: LogContext) {
      emit('warn', msg, { ...defaultCtx, ...ctx });
    },

    error(msg: string, errOrCtx?: Error | LogContext, ctx?: LogContext) {
      emit('error', msg, mergeErrorCtx(errOrCtx, ctx));
    },

    fatal(msg: string, errOrCtx?: Error | LogContext, ctx?: LogContext) {
      emit('fatal', msg, mergeErrorCtx(errOrCtx, ctx));
    },

    child(childCtx: LogContext): Logger {
      return createLogger({ ...defaultCtx, ...childCtx });
    },

    rateLimited(level: LogLevel, msg: string, key: string, ctx?: LogContext) {
      if (!dedupAllow(level, msg, key)) return;
      emit(level, msg, { ...defaultCtx, ...ctx });
    },
  };
}

/** Singleton root logger */
export const logger: Logger = createLogger();
