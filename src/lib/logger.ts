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

export interface Logger {
  debug(msg: string, ctx?: LogContext): void;
  info(msg: string, ctx?: LogContext): void;
  warn(msg: string, ctx?: LogContext): void;
  error(msg: string, errOrCtx?: Error | LogContext, ctx?: LogContext): void;
  fatal(msg: string, errOrCtx?: Error | LogContext, ctx?: LogContext): void;
  child(defaultCtx: LogContext): Logger;
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
  };
}

/** Singleton root logger */
export const logger: Logger = createLogger();
