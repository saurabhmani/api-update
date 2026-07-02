// ════════════════════════════════════════════════════════════════
//  apiPerf — lightweight route-level performance instrumentation.
//
//  Emits a single structured log line per request with total time,
//  per-step timings, SQL aggregate time, and slow-query details.
//  No external deps; safe for production hot paths.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';

const SLOW_STEP_MS = Number(process.env.API_PERF_SLOW_STEP_MS) || 500;
const SLOW_SQL_MS  = Number(process.env.API_PERF_SLOW_SQL_MS)  || 200;

export interface ApiPerfStep {
  name:       string;
  durationMs: number;
  meta?:      Record<string, unknown>;
}

export interface ApiPerfSqlQuery {
  label:      string;
  durationMs: number;
  rowCount?:  number;
}

export interface ApiPerfTracker {
  route:      string;
  mark:       (name: string, meta?: Record<string, unknown>) => void;
  time:       <T>(name: string, fn: () => Promise<T>, meta?: Record<string, unknown>) => Promise<T>;
  addSql:     (label: string, durationMs: number, rowCount?: number) => void;
  setMeta:    (key: string, value: unknown) => void;
  finish:     (extra?: Record<string, unknown>) => void;
}

export function createApiPerfTracker(route: string): ApiPerfTracker {
  const log       = logger.child({ component: 'apiPerf', route });
  const startedAt = Date.now();
  const steps:     ApiPerfStep[]     = [];
  const sqlQueries: ApiPerfSqlQuery[] = [];
  const meta:      Record<string, unknown> = {};

  let lastMarkAt = startedAt;

  const mark = (name: string, stepMeta?: Record<string, unknown>) => {
    const now = Date.now();
    steps.push({ name, durationMs: now - lastMarkAt, meta: stepMeta });
    lastMarkAt = now;
  };

  const time = async <T>(
    name: string,
    fn: () => Promise<T>,
    stepMeta?: Record<string, unknown>,
  ): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      const durationMs = Date.now() - t0;
      steps.push({ name, durationMs, meta: stepMeta });
      lastMarkAt = Date.now();
      if (durationMs >= SLOW_STEP_MS) {
        log.warn('[API_PERF_SLOW_STEP]', { route, step: name, durationMs, ...stepMeta });
      }
    }
  };

  const addSql = (label: string, durationMs: number, rowCount?: number) => {
    sqlQueries.push({ label, durationMs, rowCount });
    if (durationMs >= SLOW_SQL_MS) {
      log.warn('[API_PERF_SLOW_SQL]', { route, label, durationMs, rowCount });
    }
  };

  const finish = (extra?: Record<string, unknown>) => {
    const totalMs = Date.now() - startedAt;
    const sqlMs   = sqlQueries.reduce((s, q) => s + q.durationMs, 0);
    const slowSql = sqlQueries.filter((q) => q.durationMs >= SLOW_SQL_MS);
    const slowSteps = steps.filter((s) => s.durationMs >= SLOW_STEP_MS);

    log.info('[API_PERF]', {
      route,
      totalMs,
      sqlMs,
      sqlQueryCount: sqlQueries.length,
      stepCount:     steps.length,
      slowStepCount: slowSteps.length,
      slowSqlCount:  slowSql.length,
      steps:         steps.map((s) => ({ name: s.name, ms: s.durationMs, ...s.meta })),
      sql:           sqlQueries.map((q) => ({ label: q.label, ms: q.durationMs, rows: q.rowCount })),
      ...meta,
      ...extra,
    });
  };

  return { route, mark, time, addSql, setMeta: (k, v) => { meta[k] = v; }, finish };
}

/** Wrap a DB call to record SQL timing on an ApiPerfTracker. */
export async function timedSql<T>(
  perf: ApiPerfTracker,
  label: string,
  fn: () => Promise<T>,
  rowCountOf?: (result: T) => number,
): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  perf.addSql(label, Date.now() - t0, rowCountOf?.(result));
  return result;
}
