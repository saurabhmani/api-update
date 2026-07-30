import { AsyncLocalStorage } from 'node:async_hooks';

type CacheOutcome = 'hit' | 'miss' | 'stale';

export interface ApiPerformanceContext {
  route: string;
  method: string;
  requestId: string;
  startedAt: number;
  dbDurationMs: number;
  dbQueryCount: number;
  redisDurationMs: number;
  providerDurationMs: number;
  cacheHitCount: number;
  cacheMissCount: number;
  cacheStaleCount: number;
  tradeSetupDeduplicatedCount: number;
}

interface RouteMetric {
  route: string;
  method: string;
  requestCount: number;
  requestDurationMs: number;
  dbDurationMs: number;
  providerDurationMs: number;
  cacheHits: number;
  cacheMisses: number;
}

const requestStorage = new AsyncLocalStorage<ApiPerformanceContext>();
const routeMetrics = new Map<string, RouteMetric>();
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
    redisDurationMs: 0,
    providerDurationMs: 0,
    cacheHitCount: 0,
    cacheMissCount: 0,
    cacheStaleCount: 0,
    tradeSetupDeduplicatedCount: 0,
  }, fn);
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

export function recordDbOperation(durationMs: number): void {
  const context = requestStorage.getStore();
  if (!context) return;
  context.dbDurationMs += Math.max(0, durationMs);
  context.dbQueryCount += 1;
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
  ];
  for (const [name, help, read] of families) {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${name.endsWith('_total') ? 'counter' : 'counter'}`);
    for (const metric of values) out.push(`${name}${labels(metric)} ${read(metric)}`);
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
  return `${out.join('\n')}\n`;
}
