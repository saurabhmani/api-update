// ════════════════════════════════════════════════════════════════
//  kite/health — process-local Kite availability tracker (Phase 8)
//
//  Mirrors the *shape* of removed vendor breaker probes for ops dashboards
//  without inventing monthly quotas. Kite Connect has soft rate limits
//  and token auth — NOT an removed vendor-style 2.5k/day / 70k/month plan.
//
//  Instrumented from `KiteClient.call()` so every service-layer hop
//  is observed without touching MarketDataProvider / resolver.
// ════════════════════════════════════════════════════════════════

import {
  KiteAuthenticationError,
  KiteRateLimitError,
  KiteConfigError,
} from './errors';

const RATE_LIMIT_COOLDOWN_MS = Math.max(
  5_000,
  Number(process.env.KITE_RATE_LIMIT_COOLDOWN_MS) || 60_000,
);

export interface KiteHealthSnapshot {
  /** True when API key + access token are present in env/runtime. */
  configured: boolean;
  /** Soft availability: configured && !auth_failed && !rate_limited. */
  available: boolean;
  auth_failed: boolean;
  auth_failed_for_ms: number;
  rate_limited: boolean;
  rate_limited_remaining_ms: number;
  /** Cumulative since process boot. */
  requests: number;
  successes: number;
  failures: number;
  auth_failures: number;
  rate_limit_events: number;
  /** IST calendar-day call count — ops interest only, NOT a quota. */
  calls_today: number;
  avg_latency_ms: number;
  last_success_at: string | null;
  last_error_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_operation: string | null;
}

interface InternalState {
  requests: number;
  successes: number;
  failures: number;
  auth_failures: number;
  rate_limit_events: number;
  total_latency_ms: number;
  auth_failed_at: number | null;
  rate_limited_until: number | null;
  last_success_at: number | null;
  last_error_at: number | null;
  last_error_code: string | null;
  last_error_message: string | null;
  last_operation: string | null;
  calls_today: number;
  calls_day: string; // YYYY-MM-DD IST
}

const GLOBAL_KEY = '__q365_kite_health__';

function state(): InternalState {
  const g = globalThis as unknown as Record<string, InternalState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      requests: 0,
      successes: 0,
      failures: 0,
      auth_failures: 0,
      rate_limit_events: 0,
      total_latency_ms: 0,
      auth_failed_at: null,
      rate_limited_until: null,
      last_success_at: null,
      last_error_at: null,
      last_error_code: null,
      last_error_message: null,
      last_operation: null,
      calls_today: 0,
      calls_day: istDay(),
    };
  }
  return g[GLOBAL_KEY]!;
}

function istDay(d = new Date()): string {
  const ist = new Date(d.getTime() + 5.5 * 3_600_000);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(ist.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function rolloverDay(s: InternalState): void {
  const today = istDay();
  if (s.calls_day !== today) {
    s.calls_day = today;
    s.calls_today = 0;
  }
}

export function isKiteConfigured(): boolean {
  const apiKey = (process.env.KITE_API_KEY ?? '').trim();
  const token = (process.env.KITE_ACCESS_TOKEN ?? '').trim();
  return Boolean(apiKey && token);
}

function logHealthEvent(meta: Record<string, unknown>): void {
  const parts = Object.entries(meta)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${String(v)}`);
  console.log(`[PROVIDER] health${parts.length ? ' ' + parts.join(' ') : ''}`);
}

export interface RecordKiteCallInput {
  operation?: string;
  latencyMs?: number;
  success: boolean;
  error?: unknown;
}

/**
 * Record one Kite service-layer call. Prefer calling from `KiteClient.call`.
 */
export function recordKiteCall(input: RecordKiteCallInput): void {
  const s = state();
  rolloverDay(s);
  const now = Date.now();
  const latency = Math.max(0, input.latencyMs ?? 0);
  const op = input.operation ?? 'call';

  s.requests += 1;
  s.calls_today += 1;
  s.total_latency_ms += latency;
  s.last_operation = op;

  if (input.success) {
    s.successes += 1;
    s.last_success_at = now;
    s.auth_failed_at = null;
    s.last_error_code = null;
    s.last_error_message = null;
    logHealthEvent({
      provider: 'kite',
      operation: op,
      status: 'success',
      latency_ms: latency,
      fallback: 'none',
    });
    return;
  }

  s.failures += 1;
  s.last_error_at = now;

  const err = input.error;
  let code = 'KiteError';
  let message = err instanceof Error ? err.message : String(err ?? 'error');

  if (err instanceof KiteRateLimitError) {
    code = 'KiteRateLimitError';
    s.rate_limit_events += 1;
    s.rate_limited_until = now + RATE_LIMIT_COOLDOWN_MS;
  } else if (err instanceof KiteAuthenticationError || err instanceof KiteConfigError) {
    code = err.name;
    s.auth_failures += 1;
    s.auth_failed_at = now;
  } else if (err instanceof Error) {
    code = err.name || 'KiteError';
  }

  s.last_error_code = code;
  s.last_error_message = message.slice(0, 240);

  logHealthEvent({
    provider: 'kite',
    operation: op,
    status: 'failure',
    latency_ms: latency,
    error_type: code,
    fallback: 'none',
  });
}

/** Snapshot for health / usage / metrics routes. No monthly quota fields. */
export function getKiteHealth(): KiteHealthSnapshot {
  const s = state();
  rolloverDay(s);
  const now = Date.now();
  const configured = isKiteConfigured();
  const rateLimited = s.rate_limited_until != null && s.rate_limited_until > now;
  const authFailed = s.auth_failed_at != null;
  const avg = s.requests > 0 ? Math.round(s.total_latency_ms / s.requests) : 0;

  return {
    configured,
    available: configured && !authFailed && !rateLimited,
    auth_failed: authFailed,
    auth_failed_for_ms: authFailed && s.auth_failed_at != null
      ? Math.max(0, now - s.auth_failed_at)
      : 0,
    rate_limited: rateLimited,
    rate_limited_remaining_ms: rateLimited && s.rate_limited_until != null
      ? Math.max(0, s.rate_limited_until - now)
      : 0,
    requests: s.requests,
    successes: s.successes,
    failures: s.failures,
    auth_failures: s.auth_failures,
    rate_limit_events: s.rate_limit_events,
    calls_today: s.calls_today,
    avg_latency_ms: avg,
    last_success_at: s.last_success_at != null
      ? new Date(s.last_success_at).toISOString()
      : null,
    last_error_at: s.last_error_at != null
      ? new Date(s.last_error_at).toISOString()
      : null,
    last_error_code: s.last_error_code,
    last_error_message: s.last_error_message,
    last_operation: s.last_operation,
  };
}

/** Test helper. */
export function _resetKiteHealthForTests(): void {
  const g = globalThis as unknown as Record<string, InternalState | undefined>;
  g[GLOBAL_KEY] = undefined;
}
