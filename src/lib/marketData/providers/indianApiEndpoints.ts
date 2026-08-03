// ════════════════════════════════════════════════════════════════
//  IndianAPI Endpoints — single source of truth.
//
//  Every IndianAPI URL path used by the codebase is defined here.
//  The adapter (IndianAPIAdapter.ts) imports from this file; it must
//  never inline literal path strings of its own. When IndianAPI
//  changes a path we want exactly ONE diff.
//
//  Batch endpoints (`nse_stock_batch_live_price`) are plan/host
//  dependent — they 404 on some hosts. The ingestion orchestrator
//  probes availability at run start (INDIANAPI_BATCH_ENABLED=auto)
//  and this module tracks runtime endpoint cooldowns so a retired
//  route does not burn quota on every wave.
// ════════════════════════════════════════════════════════════════

/**
 * Resolved configuration: base URL + API key + timeout, read from env
 * on every call so tests that monkey-patch process.env reflect on the
 * next call and key rotation needs no process restart.
 */
export interface IndianApiConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

const DEFAULT_BASE_URL = 'https://stock.indianapi.in';
// Per-call timeout: 8s default / 10s ceiling. The upstream's per-IP
// throttle commonly stalls /stock for 5-10s under load — a shorter
// timeout turns those stalls into spurious retries which compound
// the load.
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS = 10000;

export function getIndianApiConfig(): IndianApiConfig {
  const baseUrl = (
    process.env.INDIANAPI_BASE_URL?.trim()
    || process.env.INDIAN_API_BASE_URL?.trim()
    || DEFAULT_BASE_URL
  ).replace(/\/+$/, '');

  const apiKey = (
    process.env.INDIANAPI_API_KEY?.trim()
    || process.env.INDIANAPI_KEY?.trim()
    || process.env.INDIAN_API_KEY?.trim()
    || ''
  );

  const rawTimeout = Number(process.env.INDIANAPI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  const timeoutMs = Math.min(Math.max(rawTimeout, 1000), MAX_TIMEOUT_MS);

  return { baseUrl, apiKey, timeoutMs };
}

/** Header name the upstream expects. */
export const INDIANAPI_AUTH_HEADER = 'X-API-Key';

/** Body field name for batch endpoints (snake_case, plural per docs). */
export const INDIANAPI_BATCH_BODY_KEY = 'stock_symbols' as const;

// ── Endpoint catalogue ─────────────────────────────────────────────

export interface EndpointSpec {
  method: 'GET' | 'POST';
  path: string;
  /** How the adapter assembles the request body. */
  body: 'none' | 'stock_symbols';
  /** true once verified end-to-end against a live key on this plan. */
  confirmed: boolean;
  verifyNote?: string;
}

export const INDIANAPI_ENDPOINTS = {
  // ── Single stock + usage (confirmed in public docs) ─────────────
  stockDetail: { method: 'GET', path: '/stock', body: 'none', confirmed: true } satisfies EndpointSpec,
  trending: { method: 'GET', path: '/trending', body: 'none', confirmed: true } satisfies EndpointSpec,
  usage: { method: 'GET', path: '/usage', body: 'none', confirmed: true } satisfies EndpointSpec,

  // ── Batch live price — plan/host dependent, probed at run start ─
  nseBatchQuote: {
    method: 'POST',
    path: '/nse_stock_batch_live_price',
    body: 'stock_symbols',
    confirmed: false,
    verifyNote: '404s on some plan hosts — orchestrator probes with 2 symbols before enabling batch mode.',
  } satisfies EndpointSpec,

  // ── Historical / fundamentals / discovery ───────────────────────
  historical: { method: 'GET', path: '/historical_data', body: 'none', confirmed: true } satisfies EndpointSpec,
  historicalStats: { method: 'GET', path: '/historical_stats', body: 'none', confirmed: true } satisfies EndpointSpec,
  industrySearch: { method: 'GET', path: '/industry_search', body: 'none', confirmed: true } satisfies EndpointSpec,
  fiftyTwoWeekHL: { method: 'GET', path: '/fetch_52_week_high_low_data', body: 'none', confirmed: true } satisfies EndpointSpec,
  nseMostActive: { method: 'GET', path: '/NSE_most_active', body: 'none', confirmed: true } satisfies EndpointSpec,
  bseMostActive: { method: 'GET', path: '/BSE_most_active', body: 'none', confirmed: true } satisfies EndpointSpec,
  priceShockers: { method: 'GET', path: '/price_shockers', body: 'none', confirmed: true } satisfies EndpointSpec,
  corporateActions: { method: 'GET', path: '/corporate_actions', body: 'none', confirmed: false,
    verifyNote: 'listed in public docs; verify availability on the subscribed plan before scheduling.',
  } satisfies EndpointSpec,
} as const;

export type EndpointName = keyof typeof INDIANAPI_ENDPOINTS;

/** Historical `period` enum accepted by /historical_data. */
export type IndianApiHistoricalPeriod = '1m' | '6m' | '1yr' | '3yr' | '5yr' | '10yr' | 'max';

// ── Runtime endpoint availability (cooldown, not permanent ban) ────
//
// When an endpoint returns a hard "route is gone" response (HTTP 404),
// the adapter marks it unavailable here. Subsequent calls short-circuit
// with a synthetic 404 so we don't burn quota probing a retired route.
// Each entry carries a timestamp; once the cooldown elapses one probe
// is allowed through. Success clears the entry; failure resets it.

const ENDPOINT_COOLDOWN_MS = (() => {
  const raw = Number(process.env.INDIANAPI_ENDPOINT_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(Math.max(raw, 5 * 60_000), 10 * 60_000);
  }
  return 5 * 60_000;
})();

interface UnavailableEntry { reason: string; markedAt: number }

const _unavailablePaths = new Map<string, UnavailableEntry>();

function isCooldownExpired(entry: UnavailableEntry): boolean {
  return Date.now() - entry.markedAt >= ENDPOINT_COOLDOWN_MS;
}

export function getEndpointCooldownMs(): number {
  return ENDPOINT_COOLDOWN_MS;
}

export function isEndpointAvailable(path: string): boolean {
  const entry = _unavailablePaths.get(path);
  if (!entry) return true;
  // Allow one probe through after cooldown.
  return isCooldownExpired(entry);
}

export function getEndpointUnavailableReason(path: string): string | null {
  const entry = _unavailablePaths.get(path);
  if (!entry || isCooldownExpired(entry)) return null;
  return entry.reason;
}

export function markEndpointUnavailable(path: string, reason: string): void {
  const existing = _unavailablePaths.get(path);
  // Suppress duplicate log lines from a thundering herd inside the
  // same active cooldown window.
  if (existing && existing.reason === reason && !isCooldownExpired(existing)) {
    return;
  }
  _unavailablePaths.set(path, { reason, markedAt: Date.now() });
  console.warn(
    `[INDIANAPI ENDPOINT UNAVAILABLE] path=${path} reason="${reason}" cooldown_ms=${ENDPOINT_COOLDOWN_MS}`,
  );
}

export function noteEndpointSuccess(path: string): void {
  if (_unavailablePaths.delete(path)) {
    console.log(`[INDIANAPI ENDPOINT RECOVERED] path=${path}`);
  }
}

/** Test hook — clear all runtime availability state. */
export function resetEndpointAvailabilityForTests(): void {
  _unavailablePaths.clear();
}
