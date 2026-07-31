import { logger } from '@/lib/logger';
import { getApiPerformanceContext } from '@/lib/monitor/apiPerformanceMetrics';

export interface RequestStage {
  name: string;
  durationMs: number;
  maxDurationMs: number;
  calls: number;
  rows?: number;
  providerCalls?: number;
  cache?: 'hit' | 'miss' | 'bypass';
}

export interface RequestStageProfiler {
  time<T>(name: string, fn: () => Promise<T>, meta?: (value: T) => Partial<RequestStage>): Promise<T>;
  mark(name: string, durationMs: number, meta?: Partial<RequestStage>): void;
  setCache(value: 'hit' | 'miss' | 'bypass'): void;
  finish(response: Response): Promise<void>;
}

const log = logger.child({ component: 'requestStageProfiler' });
const THRESHOLDS = [1_000, 500, 250, 100, 50, 20] as const;

export function createRequestStageProfiler(input: {
  route: string;
  method: string;
  requestId: string;
}): RequestStageProfiler {
  const startedAt = performance.now();
  const heapStarted = process.memoryUsage().heapUsed;
  const stages = new Map<string, RequestStage>();
  let cache: 'hit' | 'miss' | 'bypass' = 'bypass';

  const mark: RequestStageProfiler['mark'] = (name, durationMs, meta = {}) => {
    const safeDuration = Math.max(0, durationMs);
    const current = stages.get(name) ?? {
      name, durationMs: 0, maxDurationMs: 0, calls: 0,
    };
    current.durationMs += safeDuration;
    current.maxDurationMs = Math.max(current.maxDurationMs, safeDuration);
    current.calls += meta.calls ?? 1;
    if (meta.rows != null) current.rows = (current.rows ?? 0) + meta.rows;
    if (meta.providerCalls != null) {
      current.providerCalls = (current.providerCalls ?? 0) + meta.providerCalls;
    }
    if (meta.cache) current.cache = meta.cache;
    stages.set(name, current);
  };

  const time: RequestStageProfiler['time'] = async (name, fn, meta) => {
    const stageStarted = performance.now();
    const value = await fn();
    mark(name, performance.now() - stageStarted, meta?.(value));
    return value;
  };

  const finish = async (response: Response) => {
    const totalDurationMs = performance.now() - startedAt;
    let payloadSizeBytes = Number(response.headers.get('Content-Length'));
    if (!Number.isFinite(payloadSizeBytes)) {
      try { payloadSizeBytes = (await response.clone().arrayBuffer()).byteLength; }
      catch { payloadSizeBytes = 0; }
    }
    const ranked = [...stages.values()]
      .map((stage) => ({
        ...stage,
        averageMs: stage.durationMs / Math.max(1, stage.calls),
        percentTotal: totalDurationMs > 0 ? stage.durationMs / totalDurationMs * 100 : 0,
      }))
      .sort((a, b) => b.durationMs - a.durationMs);
    const slowSteps = ranked
      .filter((stage) => stage.durationMs >= 20)
      .map((stage) => ({
        ...stage,
        thresholdMs: THRESHOLDS.find((threshold) => stage.durationMs >= threshold) ?? 20,
      }));
    const perf = getApiPerformanceContext();
    if (
      process.env.NODE_ENV === 'development'
      || process.env.PERFORMANCE_BENCHMARK_HEADERS === '1'
    ) {
      response.headers.set('X-Response-Time', `${totalDurationMs.toFixed(2)}ms`);
      response.headers.set('X-DB-Time', `${perf?.dbDurationMs ?? 0}ms`);
      response.headers.set('X-Provider-Time', `${perf?.providerDurationMs ?? 0}ms`);
      response.headers.set(
        'Server-Timing',
        ranked.map((stage) => (
          `${stage.name.replace(/[^a-zA-Z0-9_-]/g, '_')};dur=${stage.durationMs.toFixed(2)}`
        )).join(', '),
      );
    }
    log.info('API stage profile', {
      event: 'q365_request_stage_profile',
      route: input.route,
      method: input.method,
      requestId: input.requestId,
      status: response.status,
      totalDurationMs,
      cache,
      databaseDurationMs: perf?.dbDurationMs ?? 0,
      databaseQueryCount: perf?.dbQueryCount ?? 0,
      databaseRowsReturned: perf?.dbRowsReturned ?? 0,
      redisDurationMs: perf?.redisDurationMs ?? 0,
      providerDurationMs: perf?.providerDurationMs ?? 0,
      cacheHitCount: perf?.cacheHitCount ?? 0,
      cacheMissCount: perf?.cacheMissCount ?? 0,
      payloadSizeBytes,
      heapDeltaBytes: process.memoryUsage().heapUsed - heapStarted,
      stages: ranked,
      slowSteps,
    });
  };

  return { time, mark, setCache: (value) => { cache = value; }, finish };
}
