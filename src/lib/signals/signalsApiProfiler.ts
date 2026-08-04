import { logger } from '@/lib/logger';
import {
  getApiPerformanceContext,
  recordSignalsPerformance,
} from '@/lib/monitor/apiPerformanceMetrics';

export interface SignalsProfileStep {
  name: string;
  durationMs: number;
  rows?: number;
  providerCalls?: number;
  cache?: 'hit' | 'miss' | 'not_used';
}

export interface SignalsApiProfiler {
  time<T>(
    name: string,
    fn: () => Promise<T>,
    meta?: (result: T) => Omit<SignalsProfileStep, 'name' | 'durationMs'>,
  ): Promise<T>;
  mark(name: string, durationMs: number, meta?: Omit<SignalsProfileStep, 'name' | 'durationMs'>): void;
  setCache(state: 'hit' | 'miss' | 'not_used'): void;
  finish(response: Response): Promise<void>;
}

const profileLog = logger.child({ component: 'signalsApiProfile' });

export function createSignalsApiProfiler(input: {
  requestId: string;
  method: string;
  route: string;
}): SignalsApiProfiler {
  const startedAt = Date.now();
  const initialHeapBytes = process.memoryUsage().heapUsed;
  const steps: SignalsProfileStep[] = [];
  let cache: 'hit' | 'miss' | 'not_used' = 'not_used';

  const mark: SignalsApiProfiler['mark'] = (name, durationMs, meta = {}) => {
    steps.push({ name, durationMs: Math.max(0, durationMs), ...meta });
  };

  const time: SignalsApiProfiler['time'] = async (name, fn, meta) => {
    const stepStartedAt = Date.now();
    const result = await fn();
    mark(name, Date.now() - stepStartedAt, meta?.(result));
    return result;
  };

  const finish = async (response: Response) => {
    const performance = getApiPerformanceContext();
    const contentLengthHeader = response.headers.get('Content-Length');
    const parsedLength = contentLengthHeader == null
      ? Number.NaN
      : Number(contentLengthHeader);
    let payloadSizeBytes = Number.isFinite(parsedLength) ? parsedLength : null;
    if (payloadSizeBytes == null && process.env.NODE_ENV === 'development') {
      try {
        payloadSizeBytes = (await response.clone().arrayBuffer()).byteLength;
      } catch {
        // Profiling must never interfere with sending the API response.
      }
    }
    const totalDurationMs = Date.now() - startedAt;
    const processingDurationMs = steps
      .filter((step) => /processing|ranking|filtering|scoring|maturity|pagination|serialization/.test(step.name))
      .reduce((sum, step) => sum + step.durationMs, 0);
    const slowSteps = steps
      .filter((step) => step.durationMs >= 20)
      .sort((a, b) => b.durationMs - a.durationMs)
      .map((step) => ({
        ...step,
        thresholdMs:
          step.durationMs >= 500 ? 500
            : step.durationMs >= 250 ? 250
              : step.durationMs >= 100 ? 100
                : step.durationMs >= 50 ? 50 : 20,
      }));
    recordSignalsPerformance({
      processingDurationMs,
      payloadSizeBytes: payloadSizeBytes ?? 0,
      steps,
    });
    if (process.env.NODE_ENV === 'development') {
      response.headers.set('X-Response-Time', `${totalDurationMs}ms`);
      response.headers.set('X-Cache', cache === 'hit' ? 'HIT' : cache === 'miss' ? 'MISS' : 'BYPASS');
      response.headers.set('X-DB-Time', `${performance?.dbDurationMs ?? 0}ms`);
      response.headers.set('X-Provider-Time', `${performance?.providerDurationMs ?? 0}ms`);
      response.headers.set(
        'Server-Timing',
        steps
          .map((step) => `${step.name.replace(/[^a-zA-Z0-9_-]/g, '_')};dur=${step.durationMs}`)
          .join(', '),
      );
    }
    profileLog.info('Signals API profile', {
      event: 'q365_signals_api_profile',
      route: input.route,
      method: input.method,
      requestId: input.requestId,
      totalDurationMs,
      status: response.status,
      steps,
      databaseDurationMs: performance?.dbDurationMs ?? 0,
      databaseQueryCount: performance?.dbQueryCount ?? 0,
      databaseRowsReturned: performance?.dbRowsReturned ?? 0,
      rowsScanned: null,
      redisDurationMs: performance?.redisDurationMs ?? 0,
      providerDurationMs: performance?.providerDurationMs ?? 0,
      providerCalls: steps.reduce((sum, step) => sum + (step.providerCalls ?? 0), 0),
      cache,
      cacheHitCount: performance?.cacheHitCount ?? 0,
      cacheMissCount: performance?.cacheMissCount ?? 0,
      payloadSizeBytes,
      processingDurationMs,
      slowSteps,
      heapDeltaBytes: process.memoryUsage().heapUsed - initialHeapBytes,
    });
  };

  return {
    time,
    mark,
    setCache: (state) => { cache = state; },
    finish,
  };
}
