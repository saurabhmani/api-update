// ════════════════════════════════════════════════════════════════
//  Engine debug logger — dedicated file transport for engine/backend
//  diagnostic traces (START / END / ERROR / DB / EXTERNAL / ROUTE).
//
//  Output: src/app/engine-debug.log  (ENGINE_DEBUG logs only)
//  Disable: ENGINE_DEBUG=0|false|off
//
//  Logging failures NEVER throw into engine processing.
//  Writes are queued asynchronously to avoid blocking hot paths.
// ════════════════════════════════════════════════════════════════

import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';

export type EngineDebugOp =
  | 'START'
  | 'END'
  | 'ERROR'
  | 'DB_QUERY_START'
  | 'DB_QUERY_END'
  | 'EXTERNAL_REQUEST_START'
  | 'EXTERNAL_REQUEST_END'
  | 'ROUTE_START'
  | 'ROUTE_END';

export interface EngineDebugContext {
  requestId?: string;
  correlationId?: string;
  engine?: string;
  file?: string;
  function?: string;
  route?: string;
}

export interface EngineDebugFields {
  engine?: string;
  requestId?: string;
  correlationId?: string;
  file?: string;
  function?: string;
  route?: string;
  operation?: string;
  target?: string;
  status?: string | number;
  durationMs?: number;
  error?: unknown;
  errorType?: string;
  meta?: Record<string, string | number | boolean | null | undefined>;
}

const SENSITIVE_KEY =
  /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|connection[_-]?string|session/i;

function isEnabled(): boolean {
  const raw = String(process.env.ENGINE_DEBUG ?? '1').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no';
}

function resolveLogPath(): string {
  const override = process.env.ENGINE_DEBUG_LOG_PATH?.trim();
  if (override) return path.resolve(override);
  return path.resolve(process.cwd(), 'src', 'app', 'engine-debug.log');
}

const als = new AsyncLocalStorage<EngineDebugContext>();

let writeQueue: Promise<void> = Promise.resolve();
let ensuredDir = false;

function ensureLogFile(): string | null {
  try {
    const logPath = resolveLogPath();
    if (!ensuredDir) {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      ensuredDir = true;
    }
    return logPath;
  } catch {
    return null;
  }
}

function enqueueWrite(line: string): void {
  if (!isEnabled()) return;
  const logPath = ensureLogFile();
  if (!logPath) return;
  writeQueue = writeQueue
    .then(
      () =>
        new Promise<void>((resolve) => {
          fs.appendFile(logPath, line + '\n', { encoding: 'utf8' }, () => resolve());
        }),
    )
    .catch(() => {
      /* never break callers */
    });
}

/** Strip secrets from free-form strings and meta bags. */
export function sanitizeEngineDebugValue(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Error) {
    return sanitizeEngineDebugValue(value.message);
  }
  let s = typeof value === 'string' ? value : String(value);
  s = s.replace(
    /(authorization|api[_-]?key|token|password|secret|cookie)\s*[:=]\s*["']?[^"'\s,;]+/gi,
    '$1=[REDACTED]',
  );
  s = s.replace(
    /(mysql|postgres|mongodb|redis):\/\/[^@\s]+@/gi,
    '$1://[REDACTED]@',
  );
  if (s.length > 500) s = `${s.slice(0, 497)}...`;
  return s.replace(/"/g, "'");
}

function sanitizeMeta(
  meta?: Record<string, string | number | boolean | null | undefined>,
): string {
  if (!meta) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    if (SENSITIVE_KEY.test(k)) {
      parts.push(`${k}=[REDACTED]`);
      continue;
    }
    parts.push(`${k}=${sanitizeEngineDebugValue(v)}`);
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Best-effort source file from the call stack. Skips this module and
 * Node internals. Returns a repo-relative `src/...` path when possible.
 */
export function captureCallerFile(extraSkip: number = 0): string {
  const stack = new Error().stack ?? '';
  const lines = stack.split('\n').slice(2 + extraSkip);
  for (const line of lines) {
    if (/engineDebugger\.(ts|js|mjs|cjs)/.test(line)) continue;
    if (/node:internal|node_modules/.test(line)) continue;
    const m =
      line.match(/\((.+?):(\d+):(\d+)\)/) ??
      line.match(/at\s+(.+?):(\d+):(\d+)/);
    if (!m) continue;
    let file = m[1].replace(/\\/g, '/');
    // Strip file:// and webpack/turbopack noise
    file = file.replace(/^file:\/\//, '');
    const srcIdx = file.lastIndexOf('/src/');
    if (srcIdx >= 0) return file.slice(srcIdx + 1);
    const appIdx = file.lastIndexOf('/app/');
    if (appIdx >= 0 && file.includes('/src/')) {
      return file.slice(file.lastIndexOf('/src/') + 1);
    }
    return file;
  }
  return 'unknown';
}

function mergeContext(fields?: EngineDebugFields): Required<
  Pick<EngineDebugFields, 'file' | 'function'>
> &
  EngineDebugFields {
  const store = als.getStore() ?? {};
  return {
    ...store,
    ...fields,
    file: fields?.file ?? store.file ?? captureCallerFile(1),
    function: fields?.function ?? store.function ?? 'anonymous',
    engine: fields?.engine ?? store.engine,
    requestId: fields?.requestId ?? store.requestId,
    correlationId: fields?.correlationId ?? store.correlationId,
    route: fields?.route ?? store.route,
  };
}

function formatLine(op: EngineDebugOp, fields?: EngineDebugFields): string {
  const f = mergeContext(fields);
  const parts: string[] = ['[ENGINE_DEBUG]'];
  if (f.requestId) parts.push(`[requestId=${f.requestId}]`);
  if (f.correlationId && f.correlationId !== f.requestId) {
    parts.push(`[correlationId=${f.correlationId}]`);
  }
  parts.push(`[file=${f.file}]`);
  parts.push(`[function=${f.function}]`);
  if (f.engine) parts.push(`[engine=${f.engine}]`);
  if (f.route) parts.push(`[route=${f.route}]`);
  parts.push(`[${op}]`);

  const ts = new Date().toISOString();
  if (op === 'START' || op === 'ROUTE_START' || op.endsWith('_START')) {
    parts.push(`timestamp=${ts}`);
  } else if (op === 'END' || op === 'ROUTE_END' || op.endsWith('_END')) {
    parts.push(`timestamp=${ts}`);
    if (f.durationMs != null) parts.push(`durationMs=${Math.round(f.durationMs)}`);
    if (f.status != null) parts.push(`status=${sanitizeEngineDebugValue(f.status)}`);
  } else if (op === 'ERROR') {
    parts.push(`timestamp=${ts}`);
    if (f.durationMs != null) parts.push(`durationMs=${Math.round(f.durationMs)}`);
    if (f.errorType) parts.push(`errorType=${sanitizeEngineDebugValue(f.errorType)}`);
    parts.push(`error="${sanitizeEngineDebugValue(f.error)}"`);
  }

  if (f.operation) parts.push(`operation=${sanitizeEngineDebugValue(f.operation)}`);
  if (f.target) parts.push(`target=${sanitizeEngineDebugValue(f.target)}`);
  parts.push(sanitizeMeta(f.meta).trimEnd());

  return parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function emit(op: EngineDebugOp, fields?: EngineDebugFields): void {
  try {
    if (!isEnabled()) return;
    enqueueWrite(formatLine(op, fields));
  } catch {
    /* never throw */
  }
}

export function getEngineDebugContext(): EngineDebugContext | undefined {
  return als.getStore();
}

/** Run `fn` inside an engine-debug ALS scope (requestId / engine / file). */
export function runWithEngineDebug<T>(
  ctx: EngineDebugContext,
  fn: () => T,
): T {
  const parent = als.getStore() ?? {};
  return als.run({ ...parent, ...ctx }, fn);
}

export async function runWithEngineDebugAsync<T>(
  ctx: EngineDebugContext,
  fn: () => Promise<T>,
): Promise<T> {
  const parent = als.getStore() ?? {};
  return als.run({ ...parent, ...ctx }, fn);
}

export interface EngineDebugSpan {
  end(status?: string | number, meta?: EngineDebugFields['meta']): void;
  error(err: unknown, meta?: EngineDebugFields['meta']): void;
  readonly startedAt: number;
}

function beginSpan(
  startOp: EngineDebugOp,
  endOp: EngineDebugOp,
  fields?: EngineDebugFields,
): EngineDebugSpan {
  const startedAt = Date.now();
  const base = mergeContext({
    ...fields,
    file: fields?.file ?? captureCallerFile(2),
  });
  emit(startOp, { ...base, meta: fields?.meta });
  return {
    startedAt,
    end(status = 'success', meta) {
      emit(endOp, {
        ...base,
        durationMs: Date.now() - startedAt,
        status,
        meta,
      });
    },
    error(err, meta) {
      const errorType = err instanceof Error ? err.name : typeof err;
      emit('ERROR', {
        ...base,
        durationMs: Date.now() - startedAt,
        status: 'failure',
        error: err,
        errorType,
        meta,
      });
    },
  };
}

/**
 * Wrap an async/sync function with automatic START / END / ERROR timing.
 */
export async function withEngineDebug<T>(
  fields: EngineDebugFields & { function: string },
  fn: () => T | Promise<T>,
): Promise<T> {
  const span = beginSpan('START', 'END', {
    ...fields,
    file: fields.file ?? captureCallerFile(1),
  });
  try {
    const result = await fn();
    span.end('success');
    return result;
  } catch (err) {
    span.error(err);
    throw err;
  }
}

/** Read engine-debug.log for the public API. Caps size; optional tail. */
export function readEngineDebugLog(opts?: {
  /** Max bytes to return (default 512 KiB). */
  maxBytes?: number;
  /** If set, return only the last N lines. */
  lines?: number;
}): {
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  sizeBytes: number;
  lineCount: number;
} {
  const logPath = resolveLogPath();
  const maxBytes = Math.max(1_024, Math.min(opts?.maxBytes ?? 512 * 1024, 2 * 1024 * 1024));
  try {
    if (!fs.existsSync(logPath)) {
      return {
        path: logPath,
        exists: false,
        content: '',
        truncated: false,
        sizeBytes: 0,
        lineCount: 0,
      };
    }
    const stat = fs.statSync(logPath);
    const sizeBytes = stat.size;
    let raw: string;
    let truncated = false;
    if (sizeBytes <= maxBytes) {
      raw = fs.readFileSync(logPath, 'utf8');
    } else {
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(maxBytes);
        fs.readSync(fd, buf, 0, maxBytes, Math.max(0, sizeBytes - maxBytes));
        raw = buf.toString('utf8');
        // Drop partial first line after a mid-file seek.
        const nl = raw.indexOf('\n');
        if (nl >= 0 && nl < raw.length - 1) raw = raw.slice(nl + 1);
        truncated = true;
      } finally {
        fs.closeSync(fd);
      }
    }
    let lines = raw.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
    if (opts?.lines != null && opts.lines > 0 && lines.length > opts.lines) {
      lines = lines.slice(-opts.lines);
      truncated = true;
    }
    return {
      path: logPath,
      exists: true,
      content: lines.join('\n') + (lines.length ? '\n' : ''),
      truncated,
      sizeBytes,
      lineCount: lines.length,
    };
  } catch {
    return {
      path: logPath,
      exists: false,
      content: '',
      truncated: false,
      sizeBytes: 0,
      lineCount: 0,
    };
  }
}

export const engineDebugger = {
  isEnabled,
  logPath: resolveLogPath,
  readLog: readEngineDebugLog,
  getContext: getEngineDebugContext,
  runWith: runWithEngineDebug,
  runWithAsync: runWithEngineDebugAsync,
  captureCallerFile,

  start(fields?: EngineDebugFields): EngineDebugSpan {
    return beginSpan('START', 'END', fields);
  },

  error(fields: EngineDebugFields & { error: unknown }): void {
    emit('ERROR', {
      ...fields,
      file: fields.file ?? captureCallerFile(1),
      errorType:
        fields.errorType ??
        (fields.error instanceof Error ? fields.error.name : typeof fields.error),
    });
  },

  dbStart(fields: EngineDebugFields & { operation: string }): EngineDebugSpan {
    return beginSpan('DB_QUERY_START', 'DB_QUERY_END', {
      ...fields,
      file: fields.file ?? captureCallerFile(1),
    });
  },

  externalStart(
    fields: EngineDebugFields & { target: string },
  ): EngineDebugSpan {
    return beginSpan('EXTERNAL_REQUEST_START', 'EXTERNAL_REQUEST_END', {
      ...fields,
      file: fields.file ?? captureCallerFile(1),
    });
  },

  routeStart(
    fields: EngineDebugFields & { route: string; function: string },
  ): EngineDebugSpan {
    return beginSpan('ROUTE_START', 'ROUTE_END', {
      ...fields,
      file: fields.file ?? captureCallerFile(1),
    });
  },

  /** Low-level emit — prefer start/dbStart/externalStart wrappers. */
  emit,
};

export default engineDebugger;
