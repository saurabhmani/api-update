// ════════════════════════════════════════════════════════════════
//  apiMonitor — in-process API health + workflow telemetry store.
//
//  Records every HTTP request the Next.js layer serves and every
//  upstream provider hop (IndianAPI / NSE / Yahoo / snapshot / DB)
//  the resolver layer makes. Exposes rollups for:
//
//    • per-day call counters (IST calendar day)
//    • per-route counters + latency stats
//    • per-provider counters + latency stats + last error
//    • fallback events
//    • slow requests ring buffer (>500ms by default)
//    • error log ring buffer
//    • last N workflow traces (see ./trace.ts)
//
//  All state is process-local. The /api/debug/system-health and
//  /api/debug/provider-report routes read from this store; restarts
//  reset the counters intentionally — long-term attribution lives in
//  q365_data_feed_health (already populated by the resolver).
//
//  Concurrency: single Node.js event loop, mutations are sync. The
//  in-memory cost is bounded — every collection has an explicit cap.
// ════════════════════════════════════════════════════════════════

import { recordIndianApiQuota } from './apiQuota';

export const SLOW_REQUEST_MS = Number(process.env.API_MONITOR_SLOW_MS) || 500;
export const HIGH_ERROR_RATE = Number(process.env.API_MONITOR_ERROR_RATE) || 0.05;
const SLOW_BUFFER_MAX  = 50;
const ERROR_BUFFER_MAX = 50;
const FALLBACK_BUFFER_MAX = 25;
const RECENT_REQUESTS_WINDOW_MS = 60_000;
const RECENT_REQUESTS_BUCKET_MS = 1_000;

export type MonitorProvider = 'indianapi' | 'nse' | 'yahoo' | 'snapshot' | 'cache' | 'db';

// ── Public input shape ─────────────────────────────────────────────

export interface RecordApiCallInput {
  /** Route path (e.g. "/api/signals"). Query string excluded. */
  route:          string;
  /** Provider that ultimately served the request, when known. */
  provider?:      MonitorProvider | null;
  /** Number of symbols the request resolved, when applicable. */
  symbolsCount?:  number;
  /** Request duration in milliseconds. */
  durationMs:     number;
  /** Whether the request returned a non-error status. */
  success:        boolean;
  /** Error code (e.g. "HTTP_500", "DATA_DEGRADED"). Null on success. */
  errorCode?:     string | null;
  /** True when the resolver cascaded past the primary provider. */
  fallbackUsed?:  boolean;
  /** ISO timestamp when the request landed. Defaults to now. */
  timestamp?:     string;
  /** HTTP method (informational, surfaced in error log entries). */
  method?:        string;
  /** Trace id correlating with the workflow tracer. */
  traceId?:       string;
}

// ── Provider latency capture ───────────────────────────────────────

export interface RecordProviderInput {
  provider:    MonitorProvider;
  durationMs:  number;
  success:     boolean;
  errorCode?:  string | null;
  fallback?:   boolean;
  symbolsCount?: number;
}

// ── Internal state shape ───────────────────────────────────────────

interface RouteStats {
  calls:          number;
  errors:         number;
  totalLatencyMs: number;
  maxLatencyMs:   number;
}

interface ProviderStats {
  calls:          number;
  errors:         number;
  totalLatencyMs: number;
  maxLatencyMs:   number;
  lastErrorCode:  string | null;
  lastCallAt:     string | null;
}

interface DailyCounts {
  date:     string;          // YYYY-MM-DD in IST
  total:    number;
  errors:   number;
  perRoute: Record<string, number>;
  perProvider: Record<string, number>;
  fallbacks: number;
}

export interface SlowRequest {
  timestamp:  string;
  route:      string;
  durationMs: number;
  provider:   MonitorProvider | null;
  fallback:   boolean;
  traceId?:   string;
}

export interface ErrorEntry {
  timestamp:  string;
  route:      string;
  method?:    string;
  provider:   MonitorProvider | null;
  errorCode:  string | null;
  durationMs: number;
  traceId?:   string;
}

export interface FallbackEntry {
  timestamp: string;
  route:     string;
  fromProvider: MonitorProvider | null;
  toProvider:   MonitorProvider | null;
  errorCode: string | null;
  traceId?:  string;
}

const routeStats    = new Map<string, RouteStats>();
const providerStats = new Map<MonitorProvider, ProviderStats>();
const slowRequests:  SlowRequest[] = [];
const errorEntries:  ErrorEntry[] = [];
const fallbackLog:   FallbackEntry[] = [];

let totalRequests   = 0;
let totalErrors     = 0;
let totalLatencyMs  = 0;
let maxLatencyMs    = 0;
let processStartedAt = new Date().toISOString();
let lastRequestAt: string | null = null;

let daily: DailyCounts = freshDay();

// Rolling per-second buckets so the UI can show a "live requests/min" gauge.
const recentBuckets = new Map<number, number>();

// ── Helpers ────────────────────────────────────────────────────────

function istDateString(d = new Date()): string {
  const ist = new Date(d.getTime() + 5.5 * 3_600_000);
  const yyyy = ist.getUTCFullYear();
  const mm   = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd   = String(ist.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function freshDay(): DailyCounts {
  return {
    date: istDateString(),
    total: 0,
    errors: 0,
    perRoute: {},
    perProvider: {},
    fallbacks: 0,
  };
}

function rolloverIfNeeded(): void {
  const today = istDateString();
  if (daily.date !== today) daily = freshDay();
}

function pushBounded<T>(arr: T[], item: T, max: number): void {
  arr.unshift(item);
  if (arr.length > max) arr.length = max;
}

function recordRecentBucket(now: number): void {
  const bucket = Math.floor(now / RECENT_REQUESTS_BUCKET_MS);
  recentBuckets.set(bucket, (recentBuckets.get(bucket) ?? 0) + 1);
  // Drop buckets older than the window so the map stays bounded.
  const cutoff = bucket - RECENT_REQUESTS_WINDOW_MS / RECENT_REQUESTS_BUCKET_MS;
  for (const k of recentBuckets.keys()) {
    if (k < cutoff) recentBuckets.delete(k);
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Record one HTTP request. Wired from `withApiHandler` so every route
 * wrapped by it lands here automatically; ad-hoc handlers may call
 * this directly.
 */
export function recordApiCall(input: RecordApiCallInput): void {
  rolloverIfNeeded();
  const ts = input.timestamp ?? new Date().toISOString();
  const route = input.route || 'unknown';
  const provider = input.provider ?? null;
  const fallback = !!input.fallbackUsed;
  const success  = !!input.success;
  const dur = Math.max(0, input.durationMs);

  totalRequests += 1;
  totalLatencyMs += dur;
  if (dur > maxLatencyMs) maxLatencyMs = dur;
  if (!success) totalErrors += 1;
  lastRequestAt = ts;

  daily.total += 1;
  if (!success) daily.errors += 1;
  daily.perRoute[route] = (daily.perRoute[route] ?? 0) + 1;
  if (provider) daily.perProvider[provider] = (daily.perProvider[provider] ?? 0) + 1;
  if (fallback) daily.fallbacks += 1;

  const rs = routeStats.get(route) ?? { calls: 0, errors: 0, totalLatencyMs: 0, maxLatencyMs: 0 };
  rs.calls += 1;
  rs.totalLatencyMs += dur;
  if (dur > rs.maxLatencyMs) rs.maxLatencyMs = dur;
  if (!success) rs.errors += 1;
  routeStats.set(route, rs);

  recordRecentBucket(Date.now());

  if (dur >= SLOW_REQUEST_MS) {
    pushBounded(slowRequests, {
      timestamp: ts, route, durationMs: dur,
      provider, fallback, traceId: input.traceId,
    }, SLOW_BUFFER_MAX);
  }

  if (!success) {
    pushBounded(errorEntries, {
      timestamp: ts, route, method: input.method, provider,
      errorCode: input.errorCode ?? null, durationMs: dur,
      traceId: input.traceId,
    }, ERROR_BUFFER_MAX);
  }
}

/**
 * Record a single provider hop (IndianAPI batch, NSE direct call,
 * Yahoo emergency, snapshot read, DB query). The resolver still owns
 * the user-facing `recordProviderCall` in marketData/providerReport
 * for cumulative call counts; this entry adds latency + error stats.
 */
export function recordProviderLatency(input: RecordProviderInput): void {
  const dur = Math.max(0, input.durationMs);
  const ps = providerStats.get(input.provider) ?? {
    calls: 0, errors: 0, totalLatencyMs: 0, maxLatencyMs: 0,
    lastErrorCode: null, lastCallAt: null,
  };
  ps.calls += 1;
  ps.totalLatencyMs += dur;
  if (dur > ps.maxLatencyMs) ps.maxLatencyMs = dur;
  if (!input.success) {
    ps.errors += 1;
    ps.lastErrorCode = input.errorCode ?? 'UNKNOWN';
  } else {
    ps.lastErrorCode = null;
  }
  ps.lastCallAt = new Date().toISOString();
  providerStats.set(input.provider, ps);

  // Spec QUOTA_TRACKING — every IndianAPI hop counts against the
  // 2,500/day · 70k–90k/month IST-aligned quota. Fire-and-forget;
  // a Redis hiccup must never break the monitor.
  if (input.provider === 'indianapi') {
    void recordIndianApiQuota(1).catch(() => { /* non-fatal */ });
  }
}

/**
 * Record a fallback handoff (primary failed → alternate served the
 * request). Surfaces in the slow / fallback tab of the dashboard.
 */
export function recordFallback(entry: Omit<FallbackEntry, 'timestamp'> & { timestamp?: string }): void {
  rolloverIfNeeded();
  daily.fallbacks += 1;
  pushBounded(fallbackLog, {
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
  }, FALLBACK_BUFFER_MAX);
}

// ── Read API (used by /api/debug/* routes) ─────────────────────────

export interface RouteSummary {
  route: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
}

export interface ProviderSummary {
  provider:     MonitorProvider;
  calls:        number;
  errors:       number;
  errorRate:    number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  lastErrorCode: string | null;
  lastCallAt:   string | null;
}

export interface MonitorSnapshot {
  processStartedAt: string;
  lastRequestAt:    string | null;
  totalRequests:    number;
  totalErrors:      number;
  errorRate:        number;
  avgLatencyMs:     number;
  maxLatencyMs:     number;
  requestsLastMinute: number;
  daily: {
    date: string;
    total: number;
    errors: number;
    fallbacks: number;
    perRoute: Record<string, number>;
    perProvider: Record<string, number>;
  };
  routes:    RouteSummary[];
  providers: ProviderSummary[];
  slowRequests: SlowRequest[];
  errorLog:     ErrorEntry[];
  fallbackLog:  FallbackEntry[];
  flags: {
    slowApi:      boolean;
    highErrorRate: boolean;
    fallbackSpike: boolean;
  };
}

function liveRequestsLastMinute(): number {
  const now = Date.now();
  const cutoff = Math.floor((now - RECENT_REQUESTS_WINDOW_MS) / RECENT_REQUESTS_BUCKET_MS);
  let total = 0;
  for (const [bucket, count] of recentBuckets.entries()) {
    if (bucket >= cutoff) total += count;
  }
  return total;
}

export function getMonitorSnapshot(): MonitorSnapshot {
  rolloverIfNeeded();
  const avgLatencyMs = totalRequests > 0 ? Math.round(totalLatencyMs / totalRequests) : 0;
  const errorRate    = totalRequests > 0 ? totalErrors / totalRequests : 0;

  const routes: RouteSummary[] = Array.from(routeStats.entries())
    .map(([route, s]) => ({
      route,
      calls: s.calls,
      errors: s.errors,
      errorRate: s.calls > 0 ? s.errors / s.calls : 0,
      avgLatencyMs: s.calls > 0 ? Math.round(s.totalLatencyMs / s.calls) : 0,
      maxLatencyMs: s.maxLatencyMs,
    }))
    .sort((a, b) => b.calls - a.calls);

  const providers: ProviderSummary[] = Array.from(providerStats.entries())
    .map(([provider, s]) => ({
      provider,
      calls: s.calls,
      errors: s.errors,
      errorRate: s.calls > 0 ? s.errors / s.calls : 0,
      avgLatencyMs: s.calls > 0 ? Math.round(s.totalLatencyMs / s.calls) : 0,
      maxLatencyMs: s.maxLatencyMs,
      lastErrorCode: s.lastErrorCode,
      lastCallAt:    s.lastCallAt,
    }));

  // Fallback spike = >10% of today's requests cascaded past the primary.
  const fallbackSpike = daily.total > 20 && (daily.fallbacks / daily.total) > 0.1;

  return {
    processStartedAt,
    lastRequestAt,
    totalRequests,
    totalErrors,
    errorRate,
    avgLatencyMs,
    maxLatencyMs,
    requestsLastMinute: liveRequestsLastMinute(),
    daily: {
      date: daily.date,
      total: daily.total,
      errors: daily.errors,
      fallbacks: daily.fallbacks,
      perRoute: { ...daily.perRoute },
      perProvider: { ...daily.perProvider },
    },
    routes,
    providers,
    slowRequests: slowRequests.slice(),
    errorLog:     errorEntries.slice(),
    fallbackLog:  fallbackLog.slice(),
    flags: {
      slowApi:       avgLatencyMs > SLOW_REQUEST_MS,
      highErrorRate: errorRate > HIGH_ERROR_RATE,
      fallbackSpike,
    },
  };
}

export function getProviderSummary(provider: MonitorProvider): ProviderSummary | null {
  const s = providerStats.get(provider);
  if (!s) return null;
  return {
    provider,
    calls: s.calls,
    errors: s.errors,
    errorRate: s.calls > 0 ? s.errors / s.calls : 0,
    avgLatencyMs: s.calls > 0 ? Math.round(s.totalLatencyMs / s.calls) : 0,
    maxLatencyMs: s.maxLatencyMs,
    lastErrorCode: s.lastErrorCode,
    lastCallAt:    s.lastCallAt,
  };
}

/** Test helper — wipe everything between cases. Production code never
 *  needs to call this. */
export function _resetApiMonitorForTests(): void {
  routeStats.clear();
  providerStats.clear();
  slowRequests.length = 0;
  errorEntries.length = 0;
  fallbackLog.length  = 0;
  recentBuckets.clear();
  totalRequests = 0;
  totalErrors   = 0;
  totalLatencyMs = 0;
  maxLatencyMs  = 0;
  processStartedAt = new Date().toISOString();
  lastRequestAt = null;
  daily = freshDay();
}
