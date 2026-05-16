// ════════════════════════════════════════════════════════════════
//  IndianAPI Endpoints — single source of truth.
//
//  Every IndianAPI URL path used by the codebase is defined here.
//  The adapter (IndianAPIAdapter.ts) imports from this file; it must
//  never inline literal path strings of its own. Treat any inline
//  '/stock'-style literal that escapes back into the adapter as a
//  regression — when IndianAPI changes a path or we discover one
//  doesn't match the documented signature, we want exactly ONE diff.
//
//  Paths flagged `// VERIFY:` were inferred from the public-facing
//  IndianAPI docs at the time of writing but have not been
//  end-to-end tested against the real account. Confirm with one
//  Postman call against the live key and adjust only the flagged
//  literal — the call signature on the adapter side stays the same.
// ════════════════════════════════════════════════════════════════

/**
 * Resolved configuration: base URL + API key, read from env once
 * per process. The adapter calls `getIndianApiConfig()` to get the
 * current values rather than capturing module-load values, so a
 * test that monkey-patches process.env reflects on the next call.
 */
export interface IndianApiConfig {
  baseUrl: string;
  apiKey:  string;
  timeoutMs: number;
}

const DEFAULT_BASE_URL = 'https://dev.indianapi.in';
// Spec "FIX INDIANAPI TIMEOUT" §1: bump the per-call timeout to 8s
// default / 10s ceiling. The dev plan's per-IP throttle commonly
// stalls /stock for 5–10s under load — at the previous 5s default
// every call was timing out before the upstream finished, which the
// retry loop then treated as transient and re-fired, compounding the
// load and producing the ~55% coverage symptom. 8s lets a typical
// stalled call complete; 10s caps the worst case.
//
// Operators can lower via INDIANAPI_TIMEOUT_MS (never raise above
// MAX_TIMEOUT_MS) so the env can never stall the resolver beyond
// the agreed ceiling.
const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TIMEOUT_MS     = 10000;

export function getIndianApiConfig(): IndianApiConfig {
  // Base URL precedence:
  //   INDIANAPI_BASE_URL  → preferred (matches the .env.example key the
  //                         user shipped)
  //   INDIAN_API_BASE_URL → backwards compat for older deployments
  //   default             → https://dev.indianapi.in (per the IndianAPI
  //                         dev-account docs the user shared)
  const baseUrl = (
    process.env.INDIANAPI_BASE_URL?.trim()
    || process.env.INDIAN_API_BASE_URL?.trim()
    || DEFAULT_BASE_URL
  ).replace(/\/+$/, '');

  // API key precedence:
  //   INDIANAPI_API_KEY   → preferred (the spec the user pinned)
  //   INDIANAPI_KEY       → existing convention used by the adapter
  //   INDIAN_API_KEY      → original env name, kept for compat
  const apiKey = (
    process.env.INDIANAPI_API_KEY?.trim()
    || process.env.INDIANAPI_KEY?.trim()
    || process.env.INDIAN_API_KEY?.trim()
    || ''
  );

  const rawTimeout = Number(process.env.INDIANAPI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  // Hard ceiling: a stray INDIANAPI_TIMEOUT_MS=15000 in prod previously
  // let the axios call hang for 15s before the fallback chain even
  // saw the failure. We refuse to honour anything above MAX_TIMEOUT_MS
  // (10s post-bump) so the .env can never re-introduce that failure mode.
  const timeoutMs = Math.min(rawTimeout, MAX_TIMEOUT_MS);

  return { baseUrl, apiKey, timeoutMs };
}

/** Header name the upstream expects. Centralised so a future rename
 *  (e.g. Bearer-style auth) is one diff. */
export const INDIANAPI_AUTH_HEADER = 'X-API-Key';

/** Body field name for batch endpoints. The user confirmed the doc
 *  spec uses `stock_symbols` (snake_case, plural). */
export const INDIANAPI_BATCH_BODY_KEY = 'stock_symbols' as const;

// ── Endpoint catalogue ─────────────────────────────────────────────

/**
 * Each entry describes how to call one IndianAPI endpoint:
 *   - method:    'GET' | 'POST'
 *   - path:      URL path (no base, no leading slash trim)
 *   - body:      'none' | 'stock_symbols' | 'stock_name' | 'free'
 *                Tells the adapter how to assemble the request body.
 *   - confirmed: true once tested end-to-end against the real key.
 *                When false, the adapter still issues the call but
 *                operators should verify response shapes before
 *                relying on the data.
 */
export interface EndpointSpec {
  method:    'GET' | 'POST';
  path:      string;
  body:      'none' | 'stock_symbols' | 'stock_name' | 'free';
  confirmed: boolean;
  /** One-line note about what to check when verifying. */
  verifyNote?: string;
}

export const INDIANAPI_ENDPOINTS = {
  // ── Single stock + usage (CONFIRMED in user docs) ───────────────
  stockDetail:    { method: 'GET', path: '/stock',    body: 'none',          confirmed: true } satisfies EndpointSpec,
  trending:       { method: 'GET', path: '/trending', body: 'none',          confirmed: true } satisfies EndpointSpec,
  usage:          { method: 'GET', path: '/usage',    body: 'none',          confirmed: true } satisfies EndpointSpec,

  // NOTE: nseBatchQuote / bseBatchQuote / intraday / industryPeers
  // were REMOVED from this catalog on 2026-05-01 after curl
  // verification confirmed they 404 on every plausible path against
  // dev.indianapi.in (the production host for this account). Adapter
  // functions are kept as `removed()` stubs so the provider interface
  // contract is preserved and the existing fallback chain (cache →
  // Yahoo emergency) continues to absorb their absence. If IndianAPI
  // publishes these routes later, restore the entries here.

  // ── Historical / fundamentals / corp ────────────────────────────
  // Path verified live 2026-05-01: server returns 200 with
  // ?stock_name=<sym>&period=1yr&filter=price. `period` enum:
  // '1m'|'6m'|'1yr'|'3yr'|'5yr'|'10yr'|'max'. `filter` is required.
  historical:        { method: 'GET',  path: '/historical_data',     body: 'none', confirmed: true } satisfies EndpointSpec,
  industrySearch:    { method: 'GET',  path: '/industry_search',     body: 'none', confirmed: true } satisfies EndpointSpec,
  // Path verified 2026-05-01 (200 with valid args). Required params:
  // stock_id, measure_code, period_type, data_type, age. age enum:
  // 'OneWeekAgo'|'ThirtyDaysAgo'|'SixtyDaysAgo'|'NinetyDaysAgo'|'Current'.
  stockForecasts:    { method: 'GET',  path: '/stock_forecasts',     body: 'none', confirmed: true } satisfies EndpointSpec,
  stockTargetPrice:  { method: 'GET',  path: '/stock_target_price',  body: 'none', confirmed: true } satisfies EndpointSpec,
  historicalStats:   { method: 'GET',  path: '/historical_stats',    body: 'none', confirmed: true } satisfies EndpointSpec,
  mutualFundSearch:  { method: 'GET',  path: '/mutual_fund_search',  body: 'none', confirmed: true } satisfies EndpointSpec,
  mutualFunds:       { method: 'GET',  path: '/mutual_funds',        body: 'none', confirmed: true } satisfies EndpointSpec,
  fiftyTwoWeekHL:    { method: 'GET',  path: '/fetch_52_week_high_low_data', body: 'none', confirmed: true } satisfies EndpointSpec,
  nseMostActive:     { method: 'GET',  path: '/NSE_most_active',     body: 'none', confirmed: true } satisfies EndpointSpec,
  bseMostActive:     { method: 'GET',  path: '/BSE_most_active',     body: 'none', confirmed: true } satisfies EndpointSpec,
  priceShockers:     { method: 'GET',  path: '/price_shockers',      body: 'none', confirmed: true } satisfies EndpointSpec,
  commodities:       { method: 'GET',  path: '/commodities',         body: 'none', confirmed: true } satisfies EndpointSpec,
  // News — paths corrected 2026-05-01 after curl verification:
  //   /market_news → /news               (200, market-wide)
  //   /stock_news  → /company_news       (200, stock-specific)
  //   /ai_news     → unchanged but adapter must pass `category`
  //                  (only certain categories are valid, e.g. 'economy',
  //                  'ipo' — others return {"Error":"Invalid category"}).
  marketNews:        { method: 'GET',  path: '/news',                body: 'none', confirmed: true } satisfies EndpointSpec,
  companyNews:       { method: 'GET',  path: '/company_news',        body: 'none', confirmed: true } satisfies EndpointSpec,
  aiCuratedNews:     { method: 'GET',  path: '/ai_news',             body: 'none', confirmed: true,
    verifyNote: 'requires `category` query param. Verified categories: economy, ipo. Adapter defaults to economy.',
  } satisfies EndpointSpec,
} as const;

export type EndpointName = keyof typeof INDIANAPI_ENDPOINTS;

/**
 * Returns the endpoints that have not yet been confirmed against the
 * live API. Useful for a one-line `[CONFIG]` boot log so an operator
 * sees at a glance which paths still need verification.
 */
export function unverifiedEndpoints(): Array<{ name: EndpointName; verifyNote: string | null }> {
  return (Object.entries(INDIANAPI_ENDPOINTS) as Array<[EndpointName, EndpointSpec]>)
    .filter(([, spec]) => !spec.confirmed)
    .map(([name, spec]) => ({
      name,
      verifyNote: spec.verifyNote ?? null,
    }));
}

// ── Runtime endpoint availability ──────────────────────────────────
//
// When an endpoint returns a hard "this route is gone" response (HTTP
// 404, persistent invalid-payload envelope), the adapter marks it
// unavailable here. Subsequent call() invocations short-circuit with
// a synthetic 404 so we don't burn quota repeatedly probing a route
// the upstream has retired.
//
// COOLDOWN, NOT PERMANENT BAN. A transient upstream glitch (one bad
// 404 from a CDN edge, one stray "route under maintenance") should
// not disable a working endpoint for the whole process lifetime.
// Each entry carries a `markedAt` timestamp; once
// INDIANAPI_ENDPOINT_COOLDOWN_MS has elapsed the path is allowed
// through as a probe. If the probe succeeds the entry is cleared
// and `[ENDPOINT RECOVERED]` is logged; if it fails again, the
// timestamp is reset and another cooldown begins.
//
// Defaults: 5 min cooldown (clamped to [5 min, 10 min] per spec).
//
// Path key (not name) is the map key so the adapter — which already
// holds the spec.path string for logging — can probe without an
// extra reverse lookup.

const ENDPOINT_COOLDOWN_MS = (() => {
  const raw = Number(process.env.INDIANAPI_ENDPOINT_COOLDOWN_MS);
  if (Number.isFinite(raw) && raw > 0) {
    // Clamp to [5 min, 10 min]. A shorter cooldown defeats the
    // purpose (the same upstream glitch will still be in flight);
    // a longer one functions as a permanent ban in disguise, which
    // the spec explicitly rules out.
    return Math.min(10 * 60_000, Math.max(5 * 60_000, raw));
  }
  return 5 * 60_000;
})();

interface UnavailableEntry {
  reason:   string;
  markedAt: number;
}

const _unavailablePaths = new Map<string, UnavailableEntry>();

function isCooldownExpired(entry: UnavailableEntry): boolean {
  return Date.now() - entry.markedAt >= ENDPOINT_COOLDOWN_MS;
}

/** True when the path is currently usable. Returns true when no
 *  entry exists OR the cooldown has elapsed (probe-eligible). The
 *  entry stays in the map until `noteEndpointSuccess` clears it,
 *  so a successful probe still carries provenance for the
 *  `[ENDPOINT RECOVERED]` log. */
export function isEndpointAvailable(path: string): boolean {
  const entry = _unavailablePaths.get(path);
  if (!entry) return true;
  return isCooldownExpired(entry);
}

/** Lookup the recorded unavailability reason. Null when the path
 *  has no entry. */
export function getEndpointUnavailableReason(path: string): string | null {
  return _unavailablePaths.get(path)?.reason ?? null;
}

/** Returns the cooldown window length (ms) — useful for diagnostics
 *  and for the adapter's "skipped: ENDPOINT_INVALID — cooldown_ms=N"
 *  error message. */
export function getEndpointCooldownMs(): number {
  return ENDPOINT_COOLDOWN_MS;
}

/** Mark a path unavailable. Stores the timestamp so the next call
 *  after the cooldown elapses is allowed through as a probe. Logs
 *  on every fresh failure (entry didn't exist, cooldown elapsed
 *  before this hit, or the reason changed) but suppresses duplicate
 *  log lines from a thundering herd inside the same active
 *  cooldown so a 50-symbol fan-out doesn't print 50 banners. */
export function markEndpointUnavailable(path: string, reason: string): void {
  const existing = _unavailablePaths.get(path);
  // Suppress only when the same reason is still inside the live
  // cooldown window. After cooldown expires, a re-trip is a
  // meaningful event ("we tried to recover, it failed again") and
  // SHOULD log again so operators can see persistent breakage.
  if (existing && existing.reason === reason && !isCooldownExpired(existing)) {
    return;
  }
  _unavailablePaths.set(path, { reason, markedAt: Date.now() });
  console.warn(
    `[ENDPOINT INVALID] path=${path} reason="${reason}" cooldown_ms=${ENDPOINT_COOLDOWN_MS}`,
  );
}

/** Called by the adapter when a call to `path` succeeded. If an
 *  unavailable entry exists (typical case: cooldown elapsed, probe
 *  call returned 200), clear it and log `[ENDPOINT RECOVERED]` so
 *  operators see the self-heal. No-op when the path was never
 *  failing — cheap to call after every successful round-trip. */
export function noteEndpointSuccess(path: string): void {
  const entry = _unavailablePaths.get(path);
  if (!entry) return;
  _unavailablePaths.delete(path);
  console.log(`[ENDPOINT RECOVERED] path=${path}`);
}

/** Test helper — clears the unavailability map. */
export function _resetEndpointAvailabilityForTests(): void {
  _unavailablePaths.clear();
}
