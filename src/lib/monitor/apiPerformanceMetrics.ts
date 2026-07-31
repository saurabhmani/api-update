import { AsyncLocalStorage } from 'node:async_hooks';

type CacheOutcome = 'hit' | 'miss' | 'stale';

export interface ApiPerformanceContext {
  route: string;
  method: string;
  requestId: string;
  startedAt: number;
  dbDurationMs: number;
  dbQueryCount: number;
  dbRowsReturned: number;
  redisDurationMs: number;
  providerDurationMs: number;
  cacheHitCount: number;
  cacheMissCount: number;
  cacheStaleCount: number;
  cacheSerializationMs: number;
  cacheDeserializationMs: number;
  tradeSetupDeduplicatedCount: number;
}

interface RouteMetric {
  route: string;
  method: string;
  requestCount: number;
  requestDurationMs: number;
  dbDurationMs: number;
  providerDurationMs: number;
  redisDurationMs: number;
  processingDurationMs: number;
  payloadSizeBytes: number;
  cacheHits: number;
  cacheMisses: number;
}

const requestStorage = new AsyncLocalStorage<ApiPerformanceContext>();
const routeMetrics = new Map<string, RouteMetric>();
const signalsStageMetrics = new Map<string, {
  calls: number;
  totalDurationMs: number;
  maxDurationMs: number;
}>();
let tradeSetupGenerationCount = 0;
let tradeSetupGenerationDurationMs = 0;
let tradeSetupDeduplicatedTotal = 0;

export function runWithApiPerformanceContext<T>(
  input: Pick<ApiPerformanceContext, 'route' | 'method' | 'requestId'>,
  fn: () => Promise<T>,
): Promise<T> {
  return requestStorage.run({
    ...input,
    startedAt: Date.now(),
    dbDurationMs: 0,
    dbQueryCount: 0,
    dbRowsReturned: 0,
    redisDurationMs: 0,
    providerDurationMs: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    cacheStaleCount: 0,
    cacheSerializationMs: 0,
    cacheDeserializationMs: 0,
    tradeSetupDeduplicatedCount: 0,
  }, fn);
}

export function recordSignalsPerformance(input: {
  processingDurationMs: number;
  payloadSizeBytes: number;
  steps?: Array<{ name: string; durationMs: number }>;
}): void {
  const context = requestStorage.getStore();
  if (!context) return;
  const key = `${context.method} ${context.route}`;
  const metric = routeMetrics.get(key) ?? {
    route: context.route,
    method: context.method,
    requestCount: 0,
    requestDurationMs: 0,
    dbDurationMs: 0,
    providerDurationMs: 0,
    redisDurationMs: 0,
    processingDurationMs: 0,
    payloadSizeBytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  metric.redisDurationMs += context.redisDurationMs;
  metric.processingDurationMs += Math.max(0, input.processingDurationMs);
  metric.payloadSizeBytes += Math.max(0, input.payloadSizeBytes);
  routeMetrics.set(key, metric);
  for (const step of input.steps ?? []) {
    const current = signalsStageMetrics.get(step.name) ?? {
      calls: 0,
      totalDurationMs: 0,
      maxDurationMs: 0,
    };
    current.calls += 1;
    current.totalDurationMs += Math.max(0, step.durationMs);
    current.maxDurationMs = Math.max(current.maxDurationMs, step.durationMs);
    signalsStageMetrics.set(step.name, current);
  }
}

export function getApiPerformanceContext(): ApiPerformanceContext | undefined {
  return requestStorage.getStore();
}

export async function observeDb<T>(fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const context = requestStorage.getStore();
    if (context) {
      context.dbDurationMs += Date.now() - startedAt;
      context.dbQueryCount += 1;
    }
  }
}

export function recordDbOperation(durationMs: number, rowsReturned = 0): void {
  const context = requestStorage.getStore();
  if (!context) return;
  context.dbDurationMs += Math.max(0, durationMs);
  context.dbQueryCount += 1;
  context.dbRowsReturned += Math.max(0, rowsReturned);
}

export async function observeProvider<T>(fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const context = requestStorage.getStore();
    if (context) context.providerDurationMs += Date.now() - startedAt;
  }
}

export async function observeRedis<T>(fn: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const context = requestStorage.getStore();
    if (context) context.redisDurationMs += Date.now() - startedAt;
  }
}

export function recordCacheOutcome(outcome: CacheOutcome): void {
  const context = requestStorage.getStore();
  if (!context) return;
  if (outcome === 'hit') context.cacheHitCount += 1;
  else if (outcome === 'stale') context.cacheStaleCount += 1;
  else context.cacheMissCount += 1;
}

export function recordCacheCodecDuration(
  operation: 'serialize' | 'deserialize',
  durationMs: number,
): void {
  const context = requestStorage.getStore();
  if (!context) return;
  if (operation === 'serialize') context.cacheSerializationMs += Math.max(0, durationMs);
  else context.cacheDeserializationMs += Math.max(0, durationMs);
}

export function recordTradeSetupGeneration(durationMs: number): void {
  tradeSetupGenerationCount += 1;
  tradeSetupGenerationDurationMs += Math.max(0, durationMs);
}

export function recordTradeSetupDeduplicated(): void {
  tradeSetupDeduplicatedTotal += 1;
  const context = requestStorage.getStore();
  if (context) context.tradeSetupDeduplicatedCount += 1;
}

export function commitApiPerformanceContext(totalDurationMs: number): void {
  const context = requestStorage.getStore();
  if (!context) return;
  const key = `${context.method} ${context.route}`;
  const metric = routeMetrics.get(key) ?? {
    route: context.route,
    method: context.method,
    requestCount: 0,
    requestDurationMs: 0,
    dbDurationMs: 0,
    providerDurationMs: 0,
    redisDurationMs: 0,
    processingDurationMs: 0,
    payloadSizeBytes: 0,
    cacheHits: 0,
    cacheMisses: 0,
  };
  metric.requestCount += 1;
  metric.requestDurationMs += Math.max(0, totalDurationMs);
  metric.dbDurationMs += context.dbDurationMs;
  metric.providerDurationMs += context.providerDurationMs;
  metric.cacheHits += context.cacheHitCount;
  metric.cacheMisses += context.cacheMissCount;
  routeMetrics.set(key, metric);
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function labels(metric: RouteMetric): string {
  return `{route="${escapeLabel(metric.route)}",method="${escapeLabel(metric.method)}"}`;
}

export function renderApiPerformanceMetrics(): string {
  const out: string[] = [];
  const values = [...routeMetrics.values()];
  const families: Array<[string, string, (metric: RouteMetric) => number]> = [
    ['q365_api_request_duration_ms', 'Cumulative API request duration in milliseconds.', (m) => m.requestDurationMs],
    ['q365_api_cache_hit_total', 'API cache hits since process start.', (m) => m.cacheHits],
    ['q365_api_cache_miss_total', 'API cache misses since process start.', (m) => m.cacheMisses],
    ['q365_api_db_duration_ms', 'Cumulative API database duration in milliseconds.', (m) => m.dbDurationMs],
    ['q365_api_provider_duration_ms', 'Cumulative API external-provider duration in milliseconds.', (m) => m.providerDurationMs],
    ['signals_request_ms', 'Cumulative Signals API request duration in milliseconds.', (m) => m.requestDurationMs],
    ['signals_db_ms', 'Cumulative Signals API database duration in milliseconds.', (m) => m.dbDurationMs],
    ['signals_cache_ms', 'Cumulative Signals API Redis duration in milliseconds.', (m) => m.redisDurationMs],
    ['signals_provider_ms', 'Cumulative Signals API provider duration in milliseconds.', (m) => m.providerDurationMs],
    ['signals_processing_ms', 'Cumulative Signals API processing duration in milliseconds.', (m) => m.processingDurationMs],
    ['signals_payload_size', 'Cumulative Signals API response payload bytes.', (m) => m.payloadSizeBytes],
    ['signals_cache_hit', 'Signals API cache hits since process start.', (m) => m.cacheHits],
    ['signals_cache_miss', 'Signals API cache misses since process start.', (m) => m.cacheMisses],
  ];
  for (const [name, help, read] of families) {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${name.endsWith('_total') ? 'counter' : 'counter'}`);
    for (const metric of values) {
      if (name.startsWith('signals_') && metric.route !== '/api/signals') continue;
      out.push(`${name}${labels(metric)} ${read(metric)}`);
    }
  }
  out.push(
    '# HELP q365_trade_setup_generation_duration_ms Cumulative trade setup generation duration in milliseconds.',
    '# TYPE q365_trade_setup_generation_duration_ms counter',
    `q365_trade_setup_generation_duration_ms ${tradeSetupGenerationDurationMs}`,
    '# HELP q365_trade_setup_generation_total Trade setup generations completed since process start.',
    '# TYPE q365_trade_setup_generation_total counter',
    `q365_trade_setup_generation_total ${tradeSetupGenerationCount}`,
    '# HELP q365_trade_setup_generation_deduplicated_total Trade setup generation requests deduplicated since process start.',
    '# TYPE q365_trade_setup_generation_deduplicated_total counter',
    `q365_trade_setup_generation_deduplicated_total ${tradeSetupDeduplicatedTotal}`,
  );
  out.push(
    '# HELP signals_stage_duration_ms_sum Cumulative Signals API stage duration.',
    '# TYPE signals_stage_duration_ms_sum counter',
    '# HELP signals_stage_duration_ms_count Signals API stage observations.',
    '# TYPE signals_stage_duration_ms_count counter',
    '# HELP signals_stage_duration_ms_max Maximum observed Signals API stage duration.',
    '# TYPE signals_stage_duration_ms_max gauge',
  );
  for (const [stage, metric] of signalsStageMetrics) {
    const stageLabel = `{stage="${escapeLabel(stage)}"}`;
    out.push(
      `signals_stage_duration_ms_sum${stageLabel} ${metric.totalDurationMs}`,
      `signals_stage_duration_ms_count${stageLabel} ${metric.calls}`,
      `signals_stage_duration_ms_max${stageLabel} ${metric.maxDurationMs}`,
    );
  }
  return `${out.join('\n')}\n`;
}
