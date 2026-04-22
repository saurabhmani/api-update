// ════════════════════════════════════════════════════════════════
//  Structured JSON Logger — Observability (Section 4)
//
//  Lightweight, dependency-free logger that emits one JSON object
//  per line to stdout/stderr. Every log carries a runId + step so
//  entries across a pipeline can be correlated.
//
//  Backward compatible: console.log/error are preserved elsewhere;
//  new code should prefer createLogger() for structured events.
// ════════════════════════════════════════════════════════════════

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  runId?: string;
  step?: string;
  symbol?: string | null;
  [key: string]: unknown;
}

export interface LogRecord extends LogContext {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface StructuredLogger {
  readonly context: LogContext;
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
  child(extra: LogContext): StructuredLogger;
  setStep(step: string): void;
}

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10, info: 20, warn: 30, error: 40,
};

interface LoggerOptions {
  level?: LogLevel;
  debug?: boolean;           // shortcut: if true, level = 'debug'
  destination?: (line: string) => void;
}

/** Resolve effective level from env + options. */
function resolveLevel(opts: LoggerOptions): LogLevel {
  if (opts.debug) return 'debug';
  if (opts.level) return opts.level;
  const env = (typeof process !== 'undefined' && process.env?.BACKTEST_LOG_LEVEL) as LogLevel | undefined;
  if (env && LEVEL_PRIORITY[env] != null) return env;
  return 'info';
}

/**
 * Create a structured logger bound to a context (runId/step/etc).
 * All emitted records are single-line JSON, safe for log aggregators.
 */
export function createLogger(context: LogContext = {}, options: LoggerOptions = {}): StructuredLogger {
  const effectiveLevel = resolveLevel(options);
  const minPriority = LEVEL_PRIORITY[effectiveLevel];
  const write = options.destination ?? ((line: string) => {
    // stdout for info/debug, stderr for warn/error — caller decides via level
    // Kept as a single sink by default; tests can override via destination.
    // eslint-disable-next-line no-console
    console.log(line);
  });

  const ctx: LogContext = { ...context };

  function emit(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < minPriority) return;
    const record: LogRecord = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...ctx,
      ...(extra ?? {}),
    };
    try {
      write(JSON.stringify(record));
    } catch {
      // If JSON serialization fails (circular refs, etc.), fall back to a safe form.
      write(JSON.stringify({
        timestamp: record.timestamp, level, message,
        runId: ctx.runId, step: ctx.step,
        _serializationError: true,
      }));
    }
  }

  const logger: StructuredLogger = {
    get context() { return ctx; },
    debug(m, e) { emit('debug', m, e); },
    info(m, e) { emit('info', m, e); },
    warn(m, e) { emit('warn', m, e); },
    error(m, e) { emit('error', m, e); },
    child(extra: LogContext) {
      return createLogger({ ...ctx, ...extra }, { ...options, level: effectiveLevel });
    },
    setStep(step: string) { ctx.step = step; },
  };

  return logger;
}

/** Default process-wide logger (no runId). Prefer createLogger per run. */
export const logger = createLogger({ component: 'backtesting' });
