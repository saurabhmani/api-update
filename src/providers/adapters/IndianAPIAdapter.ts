// ════════════════════════════════════════════════════════════════
//  IndianAPIAdapter — PRIMARY source
//
//  Responsibilities:
//    • Single-purpose: HTTP to indianapi.in and nothing else.
//    • Normalizes every payload into the canonical types from
//      /src/types/market.ts before returning.
//    • Never decides fallback policy — that's MarketDataProvider's
//      job. This adapter only returns data or throws.
//
//  ─────────────────────────────────────────────────────────────────
//  ⚠  INTEGRATION CHECKLIST — CONFIRM BEFORE PRODUCTION CUTOVER:
//
//    1. INDIANAPI_BASE_URL    → set in .env
//    2. INDIANAPI_KEY         → set in .env (sent as X-Api-Key header)
//    3. Endpoint paths below  → match the plan you subscribed to.
//       The shapes here reflect the public sample payloads from
//       indianapi.in docs at time of writing — verify against the
//       dashboard response samples before shipping.
//    4. Field names in response mappers → verify with a live
//       `curl` for one symbol and one historical range.
//
//  If any assumption is wrong, the fix is a one-file change HERE —
//  MarketDataProvider + engines are insulated by the type contract.
// ════════════════════════════════════════════════════════════════

import axios, { AxiosError, AxiosInstance } from 'axios';
import { Agent as HttpsAgent } from 'https';
import { Agent as HttpAgent } from 'http';
import { logger } from '@/lib/logger';
import type {
  CorporateIntel,
  Fundamentals,
  HistoricalCandle,
  HistoricalRange,
  HistoricalSeries,
  IndustryPeer,
  MarketSnapshot,
  MoversBucket,
  MoversResult,
  SymbolSearchHit,
} from '@/types/market';
import {
  getIndianApiConfig,
  INDIANAPI_AUTH_HEADER,
  INDIANAPI_BATCH_BODY_KEY,
  INDIANAPI_ENDPOINTS,
  isEndpointAvailable,
  markEndpointUnavailable,
  noteEndpointSuccess,
  getEndpointUnavailableReason,
  getEndpointCooldownMs,
  type EndpointSpec,
} from '@/lib/marketData/providers/indianApiEndpoints';
import {
  checkApiBudget,
  checkPerRunBudget,
  incrementApiUsage,
  ApiBudgetExceededError,
} from './indianApiUsageTracker';
import {
  validateMarketSnapshot,
  logProviderInvalidPayload,
  InvalidProviderPayloadError,
} from '@/lib/marketData/payloadValidator';
export {
  getApiUsage,
  ApiBudgetExceededError,
  INDIANAPI_DAILY_LIMIT,
  INDIANAPI_MONTHLY_LIMIT,
  INDIANAPI_PER_RUN_LIMIT,
  beginPerRunBudget,
  endPerRunBudget,
  type ApiUsageSnapshot,
  type ApiBudgetBucket,
} from './indianApiUsageTracker';

const log = logger.child({ adapter: 'IndianAPI' });

// All path / method / body decisions live in `indianApiEndpoints.ts`.
// This adapter never inlines a literal endpoint string. Base URL and
// API key likewise come from the endpoint config so swapping the host
// or rotating the key is one diff in one file.

// ── Shared axios client with HTTPS keep-alive ──────────────────────
//
// Critical perf fix (FIX-DATA-PIPELINE follow-up): the adapter used to
// build a fresh `axios.create()` on every call. Each call therefore
// did its own TCP + TLS handshake to dev.indianapi.in — fine for one
// request but catastrophic when the resolver fans out 25–28 concurrent
// /stock calls (every batch tick). Production logs showed 5s timeouts
// across the board even though `curl` from the same host returned in
// ~400 ms, because curl reuses the TLS session and axios was tearing
// it down between every call.
//
// Caching one axios instance + a keep-alive `https.Agent` lets the
// underlying socket pool reuse the TLS handshake across requests.
// Latency drops from ~5 s/req at saturation to <500 ms/req for the
// same workload. `maxSockets:25` matches INDIANAPI_EMULATED_BATCH_MAX
// so the pool never queues at the agent layer.
let _httpClient: AxiosInstance | null = null;
let _httpClientForKey: string | null = null;

function http(): AxiosInstance {
  const cfg = getIndianApiConfig();
  if (!cfg.apiKey) {
    log.warn('INDIANAPI_API_KEY (or INDIAN_API_KEY / INDIANAPI_KEY) is not set — adapter will throw on every call until configured');
  }
  // Re-build the client only when a config-bearing dimension changes
  // (key rotation, base URL flip, timeout tweak). All other calls
  // reuse the cached instance + its keep-alive socket pool.
  const cacheKey = `${cfg.baseUrl}|${cfg.apiKey}|${cfg.timeoutMs}`;
  if (_httpClient && _httpClientForKey === cacheKey) return _httpClient;

  const httpsAgent = new HttpsAgent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 25,
    maxFreeSockets: 10,
    timeout: cfg.timeoutMs,
  });
  const httpAgent = new HttpAgent({
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 25,
    maxFreeSockets: 10,
    timeout: cfg.timeoutMs,
  });

  _httpClient = axios.create({
    baseURL: cfg.baseUrl,
    timeout: cfg.timeoutMs,
    httpsAgent,
    httpAgent,
    headers: {
      [INDIANAPI_AUTH_HEADER]: cfg.apiKey,
      Accept: 'application/json',
      // Explicit keep-alive header — some upstreams close the
      // connection by default unless this is set.
      Connection: 'keep-alive',
    },
  });
  _httpClientForKey = cacheKey;
  return _httpClient;
}

// ── Raw response shapes (as documented by indianapi.in) ─────────────
//
// These are intentionally `any`-looking — we trust them only enough
// to extract the fields the mappers below actually reference, and the
// mapper itself is the authoritative contract. If IndianAPI changes
// a field name, only the mapper needs fixing.

interface RawStock {
  companyName?: string;
  tickerId?: string;
  currentPrice?: { BSE?: string; NSE?: string };
  percentChange?: string;
  yearHigh?: string;
  yearLow?: string;
  dayHigh?: string;
  dayLow?: string;
  volume?: string;
  open?: string;
  previousClose?: string;
  // Fundamentals (getCorporateIntel)
  industry?: string;
  sector?: string;
  marketCap?: string | number;
  peRatio?: string | number;
  eps?: string | number;
  dividendYield?: string | number;
  bookValue?: string | number;
  roe?: string | number;
  debtToEquity?: string | number;
}

function num(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function bestPrice(raw: RawStock): number {
  return num(raw.currentPrice?.NSE) || num(raw.currentPrice?.BSE);
}

// ── Public adapter surface ──────────────────────────────────────────

export class IndianAPIError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'IndianAPIError';
  }
}

/**
 * Throws for adapter functions whose IndianAPI route was removed
 * because the upstream has no working path on this plan (verified
 * 2026-05-01 by curl). Status=404 keeps caller fallback chains
 * (`MarketDataProvider` cache → Yahoo emergency) reacting identically
 * to a real 404 — no extra branches needed downstream.
 */
function removedEndpoint(op: string): never {
  throw new IndianAPIError(
    `IndianAPIAdapter.${op}: indianapi_route_removed (no working path on plan, verified 2026-05-01)`,
    404,
  );
}

/**
 * Single config-driven HTTP entry-point. Every adapter method routes
 * through this helper and passes the named `EndpointSpec` from the
 * endpoint config. The helper picks GET vs POST and the body shape
 * from the spec, so a path or method change is a one-diff edit in
 * `indianApiEndpoints.ts` and never the adapter.
 *
 * `query` populates URL query params (always allowed).
 * `body`  is only used when `spec.body !== 'none'`:
 *   - 'stock_symbols' wraps the value as `{ stock_symbols: <array> }`
 *   - 'stock_name'    wraps the value as `{ stock_name: <string> }`
 *   - 'free'          forwards the value verbatim
 */
interface CallOptions {
  query?: Record<string, unknown>;
  body?:  unknown;
}

/** Errors that are worth retrying once. Permanent 4xx (e.g. 404, 422)
 *  are NOT retryable — the route or input is wrong, retrying just
 *  burns quota. Anything that smells like a network blip / transient
 *  upstream stall (timeout, ECONNRESET, ECONNABORTED, axios stream
 *  abort, 502/503/504, request errors with no `response.status`) is. */
function isTransient(err: unknown): boolean {
  const ax = err as AxiosError;
  const status = ax?.response?.status;
  if (status === undefined) return true;          // network / abort / DNS
  if (status === 408 || status === 425) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

// ── Process-wide IndianAPI rate limiter ────────────────────────────
//
// The dev plan applies an aggressive per-IP throttle. Verified
// 2026-05-04 by repeated probing:
//
//   • Single sequential call:  ~1 s    response, 200 OK
//   • 28 parallel calls:        every call times out at 5 s
//   • Sustained polling burst:  IP locked out, even curl from the
//                               same host times out for ~30 s
//
// To stay within the upstream's tolerance we serialise EVERY
// IndianAPI call through one promise chain and enforce a minimum
// inter-call delay. INDIANAPI_MIN_CALL_GAP_MS env tunes the gap.
//
// Default 500ms (= 2 RPS), well under the dev-plan 10 req/s ceiling
// and inside the upstream's tested-stable band even on burst traffic.
// Previously bumped to 1500ms in a tuning attempt — reverted because
// log analysis showed the actual bottleneck is upstream latency
// (45s+ per call on the dev plan), not 429s. With 80 symbols × 2
// calls each, the 1500ms gap added 2+ minutes of pure rate-limiter
// waiting per run on top of already-slow IndianAPI calls. Bump to
// 1500ms via env if you genuinely see 429s; the breaker handles the
// upstream-throttle case fine at 500ms.
// 0 disables the limiter (NEVER do this in production).
//
// The chain replaces our previous attempt to bound concurrency at
// the resolver/scheduler layer — those bounds were necessary but
// not sufficient because multiple call sites (resolver,
// candleIngest, batchScheduler heartbeat) each maintained their
// own pool. Centralising at the adapter is the only place a
// guarantee is reachable from every code path.
const INDIANAPI_MIN_CALL_GAP_MS = (() => {
  const raw = Number(process.env.INDIANAPI_MIN_CALL_GAP_MS);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 500;
})();
let _rlChain: Promise<unknown> = Promise.resolve();
let _rlLastCallAt = 0;
// Spec OPERATIONAL OBSERVABILITY (2026-05) — depth + throttle gauges.
// _rlQueueDepth = calls currently waiting in or behind the rate-limiter
// chain. _rlPeakDepth tracks the high-water mark since the last
// reportProviderHealth() call; useful for confirming whether a stuck
// queue ever drained or just paused.
// _rlThrottleWaitTotalMs accumulates the cumulative ms callers spent
// blocked on the inter-call gap; pairs with _rlServedTotal so an
// operator can compute mean-throttle-per-call without subscribing to
// every per-call log.
let _rlQueueDepth = 0;
let _rlPeakDepth  = 0;
let _rlThrottleWaitTotalMs = 0;
let _rlServedTotal = 0;

/** Public probe for SRE dashboards. Snapshot only — does not mutate. */
export function indianApiQueueGauge(): {
  depth:                  number;
  peak_depth:             number;
  throttle_wait_total_ms: number;
  served_total:           number;
  min_call_gap_ms:        number;
} {
  return {
    depth:                  _rlQueueDepth,
    peak_depth:             _rlPeakDepth,
    throttle_wait_total_ms: _rlThrottleWaitTotalMs,
    served_total:           _rlServedTotal,
    min_call_gap_ms:        INDIANAPI_MIN_CALL_GAP_MS,
  };
}

function rateLimit<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (INDIANAPI_MIN_CALL_GAP_MS <= 0) {
    _rlServedTotal += 1;
    return fn();
  }
  _rlQueueDepth += 1;
  if (_rlQueueDepth > _rlPeakDepth) _rlPeakDepth = _rlQueueDepth;
  // Spec — emit a [QUEUE_DEPTH] line whenever the depth crosses a
  // notable threshold so operators see queue build-up early. The
  // every-N-call gating keeps the log volume bounded under steady
  // load (one line per 50 calls in flight).
  if (_rlQueueDepth >= 8 && _rlQueueDepth % 5 === 0) {
    console.warn('[QUEUE_DEPTH]', {
      provider: 'IndianAPI',
      depth:    _rlQueueDepth,
      peak:    _rlPeakDepth,
      min_call_gap_ms: INDIANAPI_MIN_CALL_GAP_MS,
    });
  }
  
  if (signal?.aborted) {
    _rlQueueDepth = Math.max(0, _rlQueueDepth - 1);
    return Promise.reject(signal.reason ?? new Error('Aborted'));
  }

  const next = _rlChain.then(async () => {
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    
    const waitStart = Date.now();
    const wait = INDIANAPI_MIN_CALL_GAP_MS - (waitStart - _rlLastCallAt);
    if (wait > 0) {
      if (signal) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, wait);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(signal.reason ?? new Error('Aborted'));
          }, { once: true });
        });
      } else {
        await new Promise((r) => setTimeout(r, wait));
      }
      _rlThrottleWaitTotalMs += wait;
      // Surface significant throttle waits — an individual caller
      // blocked >2× the configured gap is a sign the queue is
      // backing up faster than it can drain.
      if (wait >= INDIANAPI_MIN_CALL_GAP_MS * 2) {
        console.warn('[BATCH_THROTTLE]', {
          provider:        'IndianAPI',
          waited_ms:       wait,
          min_call_gap_ms: INDIANAPI_MIN_CALL_GAP_MS,
          depth:           _rlQueueDepth,
        });
      }
    }
    if (signal?.aborted) throw signal.reason ?? new Error('Aborted');
    _rlLastCallAt = Date.now();
    _rlServedTotal += 1;
    return fn();
  });
  // Swallow rejections in the chain — we still need the chain to
  // continue serialising subsequent calls even if one rejects. The
  // .finally side-effect decrements queue depth regardless of
  // resolution so a thrown call doesn't leak a depth slot forever;
  // chained off the rejection-swallowing `_rlChain` so a separate
  // unhandled-rejection isn't created when `next` rejects.
  _rlChain = next
    .catch(() => undefined)
    .finally(() => { _rlQueueDepth = Math.max(0, _rlQueueDepth - 1); });
  return next as Promise<T>;
}

// ── 429 circuit breaker (three-state, half-open probe) ──────────
//
// Spec "FIX 429" + "Half-open probe" — when IndianAPI returns 429,
// hammering through the rate limiter just produces more 429s. The
// breaker fails calls FAST during the throttle window so the
// resolver's fallback chain engages immediately instead of waiting
// for each call to round-trip and 429 again.
//
// State machine:
//
//   closed     normal operation, all calls go through
//      │
//      │ 429 received
//      ▼
//   open       all calls fail-fast with RATE_LIMITED
//      │
//      │ INDIANAPI_429_PROBE_MS elapsed (default 5s)
//      ▼
//   half-open  ONE call allowed through as a probe; subsequent
//              concurrent calls fail-fast until the probe resolves
//      │
//      ├── probe success → closed (full reset)
//      └── probe 429     → open (re-cooldown for full INDIANAPI_429_BACKOFF_MS)
//
// Defaults: 10s full cooldown, 5s probe-after. Both env-tunable.
// The probe lets us recover within ~5s when upstream's window
// resets, instead of waiting the full backoff. The "one probe at a
// time" rule prevents the 50-symbol fan-out from concurrently
// re-burning the upstream the moment the breaker reopens.
//
// Bump to 30000 (or higher) via env if you observe a probe-loop
// (open → half-open → 429 → open) in logs.
const INDIANAPI_429_BACKOFF_MS = (() => {
  const raw = Number(process.env.INDIANAPI_429_BACKOFF_MS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(10 * 60_000, Math.max(1_000, raw));
  }
  return 10_000;
})();
const INDIANAPI_429_PROBE_MS = (() => {
  const raw = Number(process.env.INDIANAPI_429_PROBE_MS);
  if (Number.isFinite(raw) && raw >= 0) {
    // Probe-after must be < full backoff, otherwise half-open never engages.
    return Math.min(INDIANAPI_429_BACKOFF_MS - 1, Math.max(0, raw));
  }
  // Default = half the backoff (5s when backoff is 10s).
  return Math.floor(INDIANAPI_429_BACKOFF_MS / 2);
})();

type BreakerState = 'closed' | 'open' | 'half_open';
let _breakerState: BreakerState = 'closed';
let _breakerOpenedAt = 0;
let _breakerHalfOpenAt = 0;
let _breakerFullCloseAt = 0;
let _halfOpenProbeInFlight = false;

function transitionTo(next: BreakerState, why: string): void {
  if (_breakerState === next) return;
  const prev = _breakerState;
  _breakerState = next;
  if (next === 'open') {
    console.warn(
      `[BREAKER OPEN] IndianAPI 429 — full cooldown ${Math.round(INDIANAPI_429_BACKOFF_MS / 1000)}s ` +
      `(half-open probe at ${Math.round(INDIANAPI_429_PROBE_MS / 1000)}s) — ${why}`,
    );
  } else if (next === 'half_open') {
    _halfOpenProbeInFlight = false;
    console.log(
      `[BREAKER HALF-OPEN] one probe call allowed (${why})`,
    );
  } else if (next === 'closed') {
    _halfOpenProbeInFlight = false;
    console.log(
      `[BREAKER RESET] IndianAPI circuit breaker reset — calls allowed again (${why}, prev=${prev})`,
    );
  }
  // Canonical provider-health tag — every breaker transition fires a
  // single greppable [PROVIDER_HEALTH] line carrying the new state,
  // queue depth, and throttle counters. SRE dashboards aggregate this
  // tag across providers without parsing each provider's bespoke log.
  console.log('[PROVIDER_HEALTH]', {
    provider:               'IndianAPI',
    breaker_state:          next,
    prev_state:             prev,
    why,
    full_cooldown_ms:       INDIANAPI_429_BACKOFF_MS,
    half_open_probe_ms:     INDIANAPI_429_PROBE_MS,
    queue_depth:            _rlQueueDepth,
    throttle_wait_total_ms: _rlThrottleWaitTotalMs,
    served_total:           _rlServedTotal,
  });
}

/** Recompute the breaker state based on wall clock. Idempotent. */
function recomputeBreakerState(): void {
  const now = Date.now();
  if (_breakerState === 'open' && now >= _breakerHalfOpenAt) {
    transitionTo('half_open', 'probe window reached');
  }
  // Half-open auto-closes if the full cooldown elapses without anything
  // probing it (e.g., zero traffic during the window).
  if (_breakerState === 'half_open' && now >= _breakerFullCloseAt && !_halfOpenProbeInFlight) {
    transitionTo('closed', 'full cooldown elapsed without probe');
  }
}

/**
 * Should this call be blocked? Returns true when the breaker is open
 * OR when half-open and a probe is already in flight. The first call
 * to enter half-open claims the probe slot (returns false) — every
 * subsequent call sees `_halfOpenProbeInFlight=true` and gets
 * fail-fast until the probe resolves.
 */
function isRateLimited(): boolean {
  recomputeBreakerState();
  if (_breakerState === 'closed') return false;
  if (_breakerState === 'open') return true;
  // half_open
  if (_halfOpenProbeInFlight) return true;
  // This call IS the probe — claim the slot atomically.
  _halfOpenProbeInFlight = true;
  return false;
}

/** Called when a call returns 429. Trips the breaker fully open. */
function tripRateLimitBreaker(): void {
  const now = Date.now();
  _breakerOpenedAt    = now;
  _breakerHalfOpenAt  = now + INDIANAPI_429_PROBE_MS;
  _breakerFullCloseAt = now + INDIANAPI_429_BACKOFF_MS;
  _halfOpenProbeInFlight = false;
  // From any state → open. The transitionTo log fires only on actual
  // state change, so a 429 during half-open re-trips silently to open
  // (we still want the open state, just no duplicate banner).
  transitionTo('open', '429 received');
}

/** Called when a call SUCCEEDS while the breaker is open or half-open
 *  — closes the breaker fully. Lets the probe close the breaker the
 *  moment upstream is healthy, instead of waiting the full backoff.
 *  Also clears the auth-failed latch in case the operator rotated
 *  the key without a server restart. */
function noteIndianApiSuccess(): void {
  if (_breakerState !== 'closed') {
    transitionTo('closed', 'probe succeeded');
  }
  if (_authFailedAt > 0) {
    console.log('[AUTH OK] IndianAPI accepted call — clearing auth-failed latch');
    _authFailedAt = 0;
  }
}

// ── Auth-failure latch (HTTP 403) ───────────────────────────────
//
// 403 is NOT 429. Where 429 means "you're calling too fast, retry
// later", 403 means "your API key is invalid / expired / blocked".
// Retrying 403 with the same key produces more 403s and burns
// quota counters on a key that's never going to authenticate.
//
// When 403 is observed, we set `_authFailedAt` once. Every
// subsequent call fails fast with AUTH_FAILED instead of paying
// the network round-trip. The latch clears on either:
//   - successful response (the key was rotated — auto-clear)
//   - 60s elapsed (give the upstream / operator a chance to fix)
// The 60s auto-clear is intentional: if an operator updates the
// env and restarts, the latch resets at boot anyway. The auto-clear
// is for the case where a transient 403 (e.g., upstream maintenance)
// recovers without a restart.
let _authFailedAt = 0;
const AUTH_FAILED_BACKOFF_MS = 60_000;

function isAuthFailed(): boolean {
  if (_authFailedAt === 0) return false;
  if (Date.now() - _authFailedAt > AUTH_FAILED_BACKOFF_MS) {
    // Auto-clear after backoff. Next call will probe.
    _authFailedAt = 0;
    return false;
  }
  return true;
}

function tripAuthFailedLatch(status: number): void {
  const wasLatched = _authFailedAt > 0;
  _authFailedAt = Date.now();
  if (!wasLatched) {
    console.error(
      `[AUTH ERROR] IndianAPI returned ${status} — API key is invalid, expired, or your IP is blocked. ` +
      `Subsequent calls will fail fast for ${Math.round(AUTH_FAILED_BACKOFF_MS / 1000)}s. ` +
      `To fix: verify INDIANAPI_API_KEY in .env.local matches the live key from your IndianAPI dashboard ` +
      `(https://indianapi.in). Common cause: env file edit truncated the key. Restart the server after fixing.`,
    );
    console.warn('[PROVIDER_HEALTH]', {
      provider:    'IndianAPI',
      auth_failed: true,
      http_status: status,
      backoff_ms:  AUTH_FAILED_BACKOFF_MS,
    });
  }
}

/** Public probe — useful for diagnostics endpoints. */
export function indianApiBreakerState(): {
  open: boolean;
  state: BreakerState;
  until: number | null;
  remainingMs: number;
  halfOpenAt: string | null;
  auth_failed: boolean;
  auth_failed_for_ms: number;
} {
  recomputeBreakerState();
  const open = _breakerState !== 'closed';
  const authFailed = isAuthFailed();
  return {
    open,
    state: _breakerState,
    until: open ? _breakerFullCloseAt : null,
    remainingMs: open ? Math.max(0, _breakerFullCloseAt - Date.now()) : 0,
    halfOpenAt:
      _breakerState === 'open' && _breakerHalfOpenAt > 0
        ? new Date(_breakerHalfOpenAt).toISOString()
        : null,
    auth_failed: authFailed,
    auth_failed_for_ms: authFailed ? Date.now() - _authFailedAt : 0,
  };
}

async function call<T>(spec: EndpointSpec, opts: CallOptions = {}, signal?: AbortSignal): Promise<T> {
  const cfg = getIndianApiConfig();
  if (!cfg.apiKey) {
    throw new IndianAPIError('INDIANAPI_API_KEY (or INDIAN_API_KEY / INDIANAPI_KEY) not configured');
  }

  // Runtime endpoint availability — fast-fail without a network
  // round-trip when this path is inside its cooldown window after
  // a recent 404. The cooldown is bounded ([5min, 10min]) so a
  // transient upstream glitch never permanently disables a working
  // route — once the window elapses, isEndpointAvailable returns
  // true and the next call below acts as a probe. Synthetic 404
  // keeps the existing fallback chain working unchanged.
  if (!isEndpointAvailable(spec.path)) {
    const why = getEndpointUnavailableReason(spec.path) ?? 'previously_failed';
    throw new IndianAPIError(
      `${spec.method} ${spec.path} skipped: ENDPOINT_INVALID — ${why} (cooldown_ms=${getEndpointCooldownMs()})`,
      404,
    );
  }

  // Fail fast when the auth-failure latch is set. Pointless to
  // burn another network round-trip on a key the upstream just
  // rejected with 403.
  if (isAuthFailed()) {
    const heldFor = Date.now() - _authFailedAt;
    throw new IndianAPIError(
      `${spec.method} ${spec.path} skipped: AUTH_FAILED — key rejected ${Math.round(heldFor / 1000)}s ago. Verify INDIANAPI_API_KEY in .env.local.`,
      403,
    );
  }
  // Fail fast when the breaker is open or half-open with an
  // in-flight probe. Synthetic 429 keeps the existing failure-
  // classification flow (cache → NSE → Yahoo cascade) working
  // without any caller-side change.
  if (isRateLimited()) {
    const remaining = Math.max(0, _breakerFullCloseAt - Date.now());
    throw new IndianAPIError(
      `${spec.method} ${spec.path} skipped: RATE_LIMITED — circuit breaker ${_breakerState} for ${Math.round(remaining / 1000)}s more`,
      429,
    );
  }
  // Spec "OPTIMIZE API USAGE" §5 — refuse the call when today's
  // budget is exhausted. Throws ApiBudgetExceededError before any
  // network round-trip so we never debit a counter we can't afford.
  // Caller paths (resolveBatch / candleIngest / route handlers) catch
  // this and surface "API budget exhausted" to the operator.
  try {
    checkApiBudget();
  } catch (err) {
    if (err instanceof ApiBudgetExceededError) {
      throw new IndianAPIError(
        `${spec.method} ${spec.path} skipped: API_BUDGET_EXCEEDED — ${err.message}`,
        429,
      );
    }
    throw err;
  }
  // Spec "Per-run API call limit" — same fail-fast pattern as the
  // daily/monthly budget, scoped to one pipeline run. Synthetic 429
  // keeps the existing fallback chain (cache → stored bars → Yahoo)
  // working unchanged. The pipeline driver wraps each run in
  // begin/endPerRunBudget so this check is a no-op outside a run.
  try {
    checkPerRunBudget();
  } catch (err) {
    if (err instanceof ApiBudgetExceededError) {
      throw new IndianAPIError(
        `${spec.method} ${spec.path} skipped: PER_RUN_LIMIT_EXCEEDED — ${err.message}`,
        429,
      );
    }
    throw err;
  }
  // From here, this call is either normal (closed) or the probe
  // (half-open). On success we close the breaker fully so subsequent
  // calls don't have to wait. On 429 we re-trip.

  // Spec "FIX INDIANAPI TIMEOUT" §3 — three attempts (= 2 retries) with
  // EXPONENTIAL backoff, env-tunable via INDIANAPI_RETRY_ATTEMPTS.
  // Backoff schedule: 200ms → 400ms → 800ms with ±25% jitter so a
  // synchronised burst doesn't hammer the upstream on retry. Permanent
  // 4xx (404 / 422 / 429) skip retries — they're route, input, or
  // throttle errors and retrying just burns quota.
  const ATTEMPTS = (() => {
    const raw = Number(process.env.INDIANAPI_RETRY_ATTEMPTS);
    if (Number.isFinite(raw) && raw >= 1 && raw <= 5) return Math.trunc(raw);
    return 3;
  })();
  let lastErr: unknown;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    try {
      // Every axios round-trip serialises through the IndianAPI rate
      // limiter so the dev plan's per-IP throttle never sees more
      // than one request in flight + the configured min-gap between
      // them. Verified: this is the only mode that consistently
      // returns 200 from /stock under sustained load.
      if (spec.method === 'GET') {
        const res = await rateLimit(() => http().get<T>(spec.path, { params: opts.query, signal }), signal);
        // Spec "OPTIMIZE API USAGE" §4 — increment AFTER a successful
        // round-trip so breaker fast-fails / auth-fail latches don't
        // wrongly debit the budget. Label the call site (path strips
        // leading slash and querystring noise) so the [API USAGE] log
        // attributes load to the right endpoint family.
        incrementApiUsage(spec.path.replace(/^\//, ''));
        noteIndianApiSuccess();
        // If this call was the post-cooldown probe, clear the
        // endpoint's unavailable entry and emit [ENDPOINT RECOVERED].
        // No-op when the path wasn't failing.
        noteEndpointSuccess(spec.path);
        return res.data;
      }
      let payload: unknown = undefined;
      if (spec.body === 'stock_symbols') {
        payload = { [INDIANAPI_BATCH_BODY_KEY]: opts.body ?? [] };
      } else if (spec.body === 'stock_name') {
        payload = { stock_name: opts.body ?? '' };
      } else if (spec.body === 'free') {
        payload = opts.body ?? {};
      }
      const res = await rateLimit(() => http().post<T>(spec.path, payload, { params: opts.query, signal }), signal);
      incrementApiUsage(spec.path.replace(/^\//, ''));
      noteIndianApiSuccess();
      noteEndpointSuccess(spec.path);
      return res.data;
    } catch (err) {
      lastErr = err;
      // Trip the breaker on 429. We DON'T retry 429 (it's not in
      // isTransient). The breaker prevents the next caller from
      // even attempting until the backoff expires.
      const status = (err as AxiosError)?.response?.status;
      if (status === 429) {
        tripRateLimitBreaker();
        break;
      }
      // Trip the auth-failed latch on 401/403. These mean the API
      // key is invalid; retrying with the same key just produces
      // more 4xx. Latch fast-fails subsequent calls for 60s.
      if (status === 401 || status === 403) {
        tripAuthFailedLatch(status);
        break;
      }
      // 404 = the path doesn't exist on this plan. Mark unavailable
      // for the rest of the process so we don't burn quota probing
      // it from every concurrent caller. Logged once per
      // (path, reason) by markEndpointUnavailable.
      if (status === 404) {
        markEndpointUnavailable(spec.path, 'http_404_route_missing');
        break;
      }
      // Non-429 failure during half-open: release the probe slot so
      // the next call can probe again. Without this, a network blip
      // during the probe would lock the breaker out indefinitely.
      if (_breakerState === 'half_open' && _halfOpenProbeInFlight) {
        _halfOpenProbeInFlight = false;
      }
      if (attempt < ATTEMPTS && isTransient(err)) {
        // Exponential backoff: 200, 400, 800ms (then capped). ±25%
        // jitter de-correlates concurrent retries.
        const base = 200 * Math.pow(2, attempt - 1);     // 200, 400, 800
        const jitter = 1 + (Math.random() - 0.5) * 0.5;  // 0.75 – 1.25
        const backoff = Math.min(2_000, Math.round(base * jitter));
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      break;
    }
  }
  const ax = lastErr as AxiosError;
  const status = ax?.response?.status;
  // Spec "FIX 429" — show the REAL attempt count, not the configured
  // ceiling. With 429 / 4xx, attemptsMade is 1; with 5xx + transient,
  // it can be up to ATTEMPTS.
  throw new IndianAPIError(
    `${spec.method} ${spec.path} failed (attempts=${attemptsMade}/${ATTEMPTS}): ${ax?.message ?? 'unknown'}${status ? ` (status=${status})` : ''}`,
    status,
  );
}

/**
 * Live snapshot for a single NSE/BSE symbol.
 * Endpoint: GET /stock?name=<symbol>  (CONFIRMED)
 *
 * IndianAPI's /stock payload does NOT expose `previousClose`, `volume`,
 * `dayHigh`, `dayLow`, or `open` at the top level on the dev plan
 * (verified 2026-05-01 — only `currentPrice.{NSE,BSE}`, `percentChange`,
 * `yearHigh`, `yearLow` are present). For prevClose / change we derive
 * from price + percentChange (algebraically exact). For OHLC/volume we
 * try the nested `keyMetrics.priceandVolume[]` and `stockTechnicalData[]`
 * before falling back to 0 — without this fallback every snapshot has
 * volume=0, prevClose=0, change=0, breaking direction breakdown,
 * manipulation engine, and option-intelligence widgets that gate on
 * those fields.
 *
 * Concurrent calls for the same symbol within the same ~100ms window
 * (rescore + lifecycle + SSE all firing together) are collapsed via
 * `inFlightQuotes` — only one HTTP call goes out, all callers receive
 * the SAME snapshot object. Treat the returned snapshot as read-only;
 * spread it (`{...snap}`) at the call site if you need to mutate.
 */
export async function getQuote(symbol: string, signal?: AbortSignal): Promise<MarketSnapshot> { // @deprecated marker
  const key = symbol.trim().toUpperCase();
  const existing = inFlightQuotes.get(key);
  if (existing) return existing;
  const p = getQuoteFresh(key, signal).finally(() => {
    if (inFlightQuotes.get(key) === p) inFlightQuotes.delete(key);
  });
  inFlightQuotes.set(key, p);
  return p;
}

/**
 * Module-scope in-flight dedup. Without this, two callers (rescore
 * tick + lifecycle tick + SSE push) firing in the same ~100ms window
 * each spawn their own /stock?name=SUNPHARMA call — same symbol,
 * three concurrent connections, three quota debits. Production logs
 * showed this exact pattern (SUNPHARMA failing twice ~340ms apart).
 */
const inFlightQuotes = new Map<string, Promise<MarketSnapshot>>();

/** Actual /stock fetch + mapping. Always goes to the network. Use
 *  `getQuote` (which dedupes) from production code paths.
 *
 *  Per the operator spec ("FIX INDIANAPI NOT BEING CALLED"), this path
 *  emits unconditional `[PROVIDER] IndianAPI CALL START / SUCCESS /
 *  FAILED` lines so every /stock hit is visible in the console without
 *  having to flip LOG_VERBOSE_SIGNALS. The deduper (`inFlightQuotes`)
 *  still collapses concurrent callers, so the START log fires once per
 *  real network call, not once per caller. */
async function getQuoteFresh(sym: string, signal?: AbortSignal): Promise<MarketSnapshot> {
  console.log('[PROVIDER] IndianAPI CALL START', sym);
  let raw: RawStockDetailed;
  try {
    raw = await call<RawStockDetailed>(INDIANAPI_ENDPOINTS.stockDetail, { query: { name: sym } }, signal);
  } catch (err) {
    const ax = err as IndianAPIError;
    console.log('[PROVIDER] IndianAPI FAILED', sym, ax?.status ?? '', ax?.message ?? String(err));
    throw err;
  }

  const price      = bestPrice(raw);
  const changePct  = num(raw.percentChange) || pickKeyMetric(raw, 'price1DayPercentChange');

  // prevClose: prefer top-level field (some plans expose it), else
  // derive from price/changePct. Derivation only valid when changePct
  // is numerically meaningful — at exactly 0% the formula degenerates
  // but the day-flat case (prevClose === price) still falls out
  // correctly via the fall-through `price` assignment.
  let prevClose: number;
  const rawPrev = num(raw.previousClose);
  if (rawPrev > 0) {
    prevClose = rawPrev;
  } else if (price > 0 && changePct !== 0) {
    prevClose = price / (1 + changePct / 100);
  } else {
    prevClose = price;
  }
  const change = price - prevClose;

  // Volume from /stock — top-level `volume` first, else keyMetrics
  // 10-day average (in lakhs, multiply by 1e5 to get shares).
  let volume = num(raw.volume);
  if (volume === 0) {
    const avgLakhs = pickKeyMetric(raw, 'avgTradingVolumeLast10Days');
    if (avgLakhs > 0) volume = Math.round(avgLakhs * 100_000);
  }

  const snapshot: MarketSnapshot = {
    symbol: sym,
    price,
    ltp: price,
    change,
    changePercent: changePct,
    volume,
    // OHLC: /stock doesn't expose intraday day-high/day-low/open on the
    // dev plan — ONLY year-high/year-low and historical points exist.
    // Don't fall back to yearHigh/yearLow here: a consumer that gates
    // on `high > 0` would treat the 52-week high as today's high and
    // emit nonsensical intraday range / breakout signals. Returning 0
    // is the honest signal that intraday OHLC is unavailable for this
    // snapshot — modules that need it should fetch /historical_data.
    open: num(raw.open),
    high: num(raw.dayHigh),
    low:  num(raw.dayLow),
    prevClose,
    timestamp: Date.now(),
  };
  // Spec PROVIDER-NORMALIZE-2026-05 — gate every snapshot before
  // returning to the resolver. Rejects price <= 0, volume = 0 during
  // market hours, NaN/Infinity. Throws InvalidProviderPayloadError so
  // the caller can fall through to NSE / Yahoo / cache instead of
  // shipping a synthetic price=0 row into Phase 3 scoring.
  const validation = validateMarketSnapshot(snapshot);
  if (!validation.ok) {
    logProviderInvalidPayload('IndianAPI', sym, validation.reasons, raw);
    console.log('[PROVIDER] IndianAPI INVALID', sym, validation.reasons.join(','));
    throw new InvalidProviderPayloadError('IndianAPI', sym, validation.reasons);
  }
  console.log('[PROVIDER] IndianAPI SUCCESS', sym, `price=${price}`, `chg%=${changePct}`, `vol=${volume}`);
  return snapshot;
}

/** /stock payload extras the original RawStock interface didn't model. */
interface RawStockDetailed extends RawStock {
  yearHigh?:  string;
  yearLow?:   string;
  keyMetrics?: {
    priceandVolume?: Array<{ key?: string; value?: string | number }>;
  };
}

/** Look up a `keyMetrics.priceandVolume[]` value by its `key` field.
 *  Returns 0 when missing — same shape as `num()` so call sites stay
 *  uniform. */
function pickKeyMetric(raw: RawStockDetailed, key: string): number {
  const list = raw.keyMetrics?.priceandVolume;
  if (!Array.isArray(list)) return 0;
  for (const row of list) {
    if (row?.key === key) return num(row.value);
  }
  return 0;
}

/**
 * Historical close-price series.
 * Endpoint: GET /historical_data?stock_name=<sym>&period=<enum>&filter=price  (VERIFIED 2026-05-01)
 *
 * IndianAPI's /historical_data on the dev plan returns CLOSE PRICES ONLY —
 * there is no OHLCV. Valid `period` enum: '1m'|'6m'|'1yr'|'3yr'|'5yr'|'10yr'|'max'.
 * `filter` is REQUIRED (default|price|pe|sm|evebitda|ptb|mcs); we send `price`.
 *
 * Until 2026-05-01 the adapter sent `period=1y` (invalid — returns 422)
 * and omitted `filter` (also a 422). Every candle ingest call therefore
 * failed and the signal engine had no bars to score. Mapping the typed
 * `HistoricalRange` to the upstream's enum + sending `filter=price`
 * recovers the call to a 200.
 *
 * Because the upstream is close-only, we synthesise OHLC by setting
 * o=h=l=close and v=0. `validateCandle` (utils/candles.ts) accepts that
 * shape (open>0, high>=low, close>0, volume>=0). Indicators that need
 * real volume (OBV, A/D, etc.) will be neutral on these bars; close-
 * based indicators (RSI, MACD, EMA, BB, etc.) are unaffected.
 */
function mapRangeToIndianPeriod(range: HistoricalRange): string {
  // IndianAPI accepts: 1m | 6m | 1yr | 3yr | 5yr | 10yr | max.
  // Our internal HistoricalRange covers shorter windows (1d/5d) that
  // IndianAPI does not expose — fall through to 1m (smallest available).
  switch (range) {
    case '1d':
    case '5d':
    case '1mo': return '1m';
    case '3mo':
    case '6mo': return '6m';
    case '1y':  return '1yr';
    case '5y':  return '5yr';
    default:    return '1yr';
  }
}

export async function getHistorical(
  symbol: string,
  range: HistoricalRange,
  signal?: AbortSignal,
): Promise<HistoricalSeries> {
  const sym = symbol.trim().toUpperCase();
  const period = mapRangeToIndianPeriod(range);
  const filter = 'price';
  let raw: { datasets?: Array<{ metric?: string; values?: Array<[string, string | number]> }> };
  try {
    raw = await call<typeof raw>(
      INDIANAPI_ENDPOINTS.historical,
      { query: { stock_name: sym, period, filter } },
      signal,
    );
  } catch (err) {
    const ax = err as IndianAPIError;
    log.warn('historical_data fetch failed', {
      symbol: sym, period, filter, status: ax?.status, message: ax?.message,
    });
    // Return an empty series instead of throwing — the candle-ingest
    // layer treats `candles.length === 0` as a clean skip (negative-
    // cached for 1h) so a single bad symbol never blocks the pipeline.
    return { symbol: sym, range, candles: [] };
  }

  // IndianAPI returns parallel arrays keyed by metric (Price / Volume
  // / etc). We align them by date. If the shape differs on your plan,
  // this is the one block to rewrite.
  const byDate = new Map<string, Partial<HistoricalCandle> & { t: number }>();
  for (const ds of raw.datasets ?? []) {
    const metric = (ds.metric ?? '').toLowerCase();
    for (const [dateStr, valueStr] of ds.values ?? []) {
      const t = Date.parse(dateStr);
      if (!Number.isFinite(t)) continue;
      const bucket = byDate.get(dateStr) ?? { t };
      const v = num(valueStr);
      if (metric.includes('price')) bucket.c = v;
      else if (metric.includes('volume')) bucket.v = v;
      else if (metric.includes('high')) bucket.h = v;
      else if (metric.includes('low'))  bucket.l = v;
      else if (metric.includes('open')) bucket.o = v;
      byDate.set(dateStr, bucket);
    }
  }

  const candles: HistoricalCandle[] = [...byDate.values()]
    .map(b => ({
      t: b.t,
      o: b.o ?? b.c ?? 0,
      h: b.h ?? b.c ?? 0,
      l: b.l ?? b.c ?? 0,
      c: b.c ?? 0,
      v: b.v ?? 0,
    }))
    .sort((a, b) => a.t - b.t);

  return { symbol: sym, range, candles };
}

/** Endpoint: GET /industry_search?query=<q>  (VERIFY) */
export async function searchSymbol(query: string, signal?: AbortSignal): Promise<SymbolSearchHit[]> {
  const raw = await call<Array<{ symbol?: string; companyName?: string; exchange?: string; type?: string }>>(
    INDIANAPI_ENDPOINTS.industrySearch,
    { query: { query } },
    signal,
  );
  return (raw ?? [])
    .filter(h => h.symbol)
    .map(h => ({
      symbol: String(h.symbol).toUpperCase(),
      name: h.companyName ?? h.symbol ?? '',
      exchange: h.exchange,
      type: h.type,
    }));
}

/** Endpoint: GET /trending  (CONFIRMED) */
export async function getMovers(signal?: AbortSignal): Promise<MoversResult> {
  const raw = await call<{
    trending_stocks?: { top_gainers?: RawStock[]; top_losers?: RawStock[] };
  }>(INDIANAPI_ENDPOINTS.trending, undefined, signal);
  const mapBucket = (s: RawStock): MoversBucket => ({
    symbol: String(s.tickerId ?? '').toUpperCase(),
    price: bestPrice(s),
    changePercent: num(s.percentChange),
  });
  return {
    gainers:    (raw.trending_stocks?.top_gainers ?? []).map(mapBucket),
    losers:     (raw.trending_stocks?.top_losers  ?? []).map(mapBucket),
    mostActive: [],  // not exposed on trending endpoint
  };
}

/** Endpoint: GET /stock?name=<sym> (same payload as getQuote)  (CONFIRMED) */ // @deprecated marker
export async function getCorporateIntel(symbol: string, signal?: AbortSignal): Promise<CorporateIntel> {
  const sym = symbol.trim().toUpperCase();
  const raw = await call<RawStock>(INDIANAPI_ENDPOINTS.stockDetail, { query: { name: sym } }, signal);
  return {
    symbol: sym,
    companyName: raw.companyName ?? sym,
    sector:   raw.sector,
    industry: raw.industry,
    marketCap:     num(raw.marketCap)      || undefined,
    pe:            num(raw.peRatio)        || undefined,
    eps:           num(raw.eps)            || undefined,
    dividendYield: num(raw.dividendYield)  || undefined,
    bookValue:     num(raw.bookValue)      || undefined,
    roe:           num(raw.roe)            || undefined,
    debtToEquity:  num(raw.debtToEquity)   || undefined,
  };
}

/**
 * Fundamentals — aggregates valuation, profitability, leverage, growth,
 * forecasts, and analyst targets into one normalized response.
 *
 * Verified 2026-05-01: /stock_forecasts and /stock_target_price both
 * REQUIRE `stock_id` (and /stock_forecasts also requires `measure_code`,
 * `period_type`, `data_type`, `age`). Our prior call shape sent only
 * `stock_name` to both → both upstream calls 422'd silently inside the
 * `.catch(() => ({}))` swallow. Even worse, the live response shapes
 * (`{measureCode, measureName, periods:[...]}` for forecasts;
 * `{priceTarget:{Mean,High,Low,...}}` for target_price) do NOT match
 * the `revenue_growth_yoy`/`earnings_growth_yoy`/`target_price` field
 * names this mapper is reading — even after fixing the params, none
 * of the read fields would land. Net effect: 2 of 3 fanout calls were
 * pure quota burn (3 units billed, 1 unit yielding data).
 *
 * Until a proper mapping for the real upstream payloads is written
 * (separate task — needs the `periods[]` shape modelling), we drop
 * the two broken calls. Forecast / analyst-target fields stay
 * `undefined`, which is exactly what the previous shape produced
 * because the mapping never matched. Cost reduction: 3 → 1 unit per
 * fundamentals fetch. Provider wrapper cost will be re-tuned in
 * indianApiProvider.ts to match.
 */
export async function getFundamentals(symbol: string, signal?: AbortSignal): Promise<Fundamentals> {
  const sym = symbol.trim().toUpperCase();

  const stock = await call<RawStock & {
    pb?: unknown; ps?: unknown; peg?: unknown;
    evToEbitda?: unknown; roa?: unknown; roce?: unknown;
    netMargin?: unknown; operatingMargin?: unknown;
    interestCoverage?: unknown; payoutRatio?: unknown;
  }>(INDIANAPI_ENDPOINTS.stockDetail, { query: { name: sym } }, signal).catch(() => ({} as RawStock));

  // Forecast + target endpoints intentionally NOT called — see note
  // above. Use `getStockForecasts`/`getStockTargetPrice` standalones
  // when those payloads are needed; they pass the correct params.
  const forecasts: { revenue_growth_yoy?: number; earnings_growth_yoy?: number } = {};
  const targets:   { target_price?: number; rating_avg?: number; analyst_count?: number } = {};

  return {
    symbol: sym,
    companyName: stock.companyName ?? sym,
    pe:            num((stock as RawStock).peRatio) || undefined,
    pb:            num((stock as { pb?: unknown }).pb) || undefined,
    ps:            num((stock as { ps?: unknown }).ps) || undefined,
    peg:           num((stock as { peg?: unknown }).peg) || undefined,
    evToEbitda:    num((stock as { evToEbitda?: unknown }).evToEbitda) || undefined,
    roe:           num(stock.roe) || undefined,
    roa:           num((stock as { roa?: unknown }).roa) || undefined,
    roce:          num((stock as { roce?: unknown }).roce) || undefined,
    netMargin:     num((stock as { netMargin?: unknown }).netMargin) || undefined,
    operatingMargin: num((stock as { operatingMargin?: unknown }).operatingMargin) || undefined,
    debtToEquity:  num(stock.debtToEquity) || undefined,
    interestCoverage: num((stock as { interestCoverage?: unknown }).interestCoverage) || undefined,
    revenueGrowthYoY:  num(forecasts.revenue_growth_yoy)  || undefined,
    earningsGrowthYoY: num(forecasts.earnings_growth_yoy) || undefined,
    dividendYield: num(stock.dividendYield) || undefined,
    payoutRatio:   num((stock as { payoutRatio?: unknown }).payoutRatio) || undefined,
    analystTargetPrice: num(targets.target_price)  || undefined,
    analystRatingAvg:   num(targets.rating_avg)    || undefined,
    analystCount:       num(targets.analyst_count) || undefined,
    asOf: Date.now(),
  };
}

/**
 * REMOVED — IndianAPI has no working industry_peers route on this
 * plan (every plausible path 404'd on 2026-05-01). The function is
 * kept as a stub so the provider interface contract holds and the
 * MarketDataProvider fallback chain (cache → empty array) absorbs
 * the absence. Restore the catalog entry + body if the upstream
 * publishes a working route.
 */
export async function getIndustryPeers(_symbol: string): Promise<IndustryPeer[]> {
  return removedEndpoint('getIndustryPeers');
}

// ════════════════════════════════════════════════════════════════
//  Additional documented endpoints (indianapi.in/documentation)
//
//  These are lighter-touch wrappers — the upstream payload shape is
//  passed through as `unknown`-typed records. Callers that want
//  canonical shapes for mutual funds / commodities / etc. should add
//  mappers in this file once those types land in /src/types/market.ts.
// ════════════════════════════════════════════════════════════════

/** GET /mutual_fund_search?query=<q>  (VERIFY) */
export async function searchMutualFunds(query: string, signal?: AbortSignal): Promise<unknown[]> {
  const raw = await call<unknown>(INDIANAPI_ENDPOINTS.mutualFundSearch, { query: { query } }, signal);
  return Array.isArray(raw) ? raw : [];
}

/** GET /mutual_funds — latest data for all mutual funds  (VERIFY) */
export async function getMutualFunds(): Promise<unknown> {
  return call<unknown>(INDIANAPI_ENDPOINTS.mutualFunds);
}

/** GET /fetch_52_week_high_low_data  (VERIFY) */
export async function get52WeekHighLow(): Promise<unknown> {
  return call<unknown>(INDIANAPI_ENDPOINTS.fiftyTwoWeekHL);
}

/** GET /NSE_most_active  (VERIFY) */
export async function getNseMostActive(): Promise<MoversBucket[]> {
  const raw = await call<RawStock[]>(INDIANAPI_ENDPOINTS.nseMostActive);
  return (raw ?? []).map(s => ({
    symbol: String(s.tickerId ?? s.companyName ?? '').toUpperCase(),
    price: bestPrice(s),
    changePercent: num(s.percentChange),
  }));
}

/** GET /BSE_most_active  (VERIFY) */
export async function getBseMostActive(): Promise<MoversBucket[]> {
  const raw = await call<RawStock[]>(INDIANAPI_ENDPOINTS.bseMostActive);
  return (raw ?? []).map(s => ({
    symbol: String(s.tickerId ?? s.companyName ?? '').toUpperCase(),
    price: bestPrice(s),
    changePercent: num(s.percentChange),
  }));
}

/** GET /price_shockers  (VERIFY) */
export async function getPriceShockers(): Promise<string[]> {
  const raw = await call<
    { stocks?: Array<{ symbol?: string; tickerId?: string }> } |
    Array<{ symbol?: string; tickerId?: string }>
  >(INDIANAPI_ENDPOINTS.priceShockers);
  const list = Array.isArray(raw) ? raw : (raw.stocks ?? []);
  return list
    .map(r => String(r.symbol ?? r.tickerId ?? '').toUpperCase())
    .filter(Boolean);
}

/** GET /commodities  (VERIFY) */
export async function getCommodities(): Promise<unknown> {
  return call<unknown>(INDIANAPI_ENDPOINTS.commodities);
}

/** GET /stock_target_price?stock_id=<id>  (VERIFY) */
export async function getStockTargetPrice(stockId: string): Promise<unknown> {
  return call<unknown>(INDIANAPI_ENDPOINTS.stockTargetPrice, { query: { stock_id: stockId } });
}

/** GET /stock_forecasts  (VERIFY) */
export async function getStockForecasts(
  stockId: string,
  opts: {
    measureCode?: string;
    periodType?: string;
    dataType?: string;
    age?: string;
  } = {},
): Promise<unknown> {
  return call<unknown>(INDIANAPI_ENDPOINTS.stockForecasts, {
    query: {
      stock_id:     stockId,
      measure_code: opts.measureCode ?? 'EPS',
      period_type:  opts.periodType  ?? 'Annual',
      data_type:    opts.dataType    ?? 'Actuals',
      age:          opts.age         ?? 'OneYear',
    },
  });
}

/** GET /historical_stats  (VERIFY) */
export async function getHistoricalStats(
  symbol: string,
  stats: string,
): Promise<unknown> {
  const sym = symbol.trim().toUpperCase();
  return call<unknown>(INDIANAPI_ENDPOINTS.historicalStats, { query: { stock_name: sym, stats } });
}

/**
 * GET /usage  (CONFIRMED) — current API usage counter from the
 * upstream account. Useful for the budget guard's authoritative
 * "remaining quota" reading rather than relying solely on the
 * locally-counted spend ledger.
 */
export async function getUsage(signal?: AbortSignal): Promise<unknown> {
  return call<unknown>(INDIANAPI_ENDPOINTS.usage, {}, signal);
}

// ════════════════════════════════════════════════════════════════════
//  Tiered-scheduler additions (Priority 1B quota-reduction refactor).
//
//  These methods power the batchScheduler's Tier A (market-wide cheap
//  endpoints + batch quotes), Tier B (news-aware trigger scoring), and
//  Tier C (news/intel) phases. They are called through MarketDataProvider
//  wrappers that apply budget-guard spend() accounting — never from
//  engines or routes directly.
// ════════════════════════════════════════════════════════════════════

/** Unified news row returned by both /market_news and /stock_news. */
export interface NewsItem {
  /** Present only for company-specific news. */
  symbol?: string;
  headline: string;
  source?: string;
  url?: string;
  /** epoch ms */
  publishedAt: number;
  summary?: string;
}

/** Result envelope for getBatchQuotes — snapshots[] holds every symbol
 *  the upstream returned; missing[] lists symbols we asked for but the
 *  upstream omitted. */
export interface BatchQuoteResult {
  snapshots: MarketSnapshot[];
  missing: string[];
}

/**
 * EMULATED batch — IndianAPI's `/nse/batch_quote` and `/bse/batch_quote`
 * routes 404 on this plan (verified 2026-05-01, every plausible alternate
 * path also 404'd). This shim fans out concurrent calls to the verified
 * single-symbol `/stock?name=` endpoint and aggregates them into the
 * same `BatchQuoteResult` shape callers already expect.
 *
 * Cost model: ONE upstream call per symbol. Callers (the resolver,
 * scheduler) MUST cap the symbol count via `MAX_EMULATED_BATCH_SYMBOLS`
 * to keep monthly quota under the 70k ceiling — refreshing the full
 * 504-symbol universe every tick would burn ~80k+/month at Tier A
 * cadence alone. If `symbols.length` exceeds the cap, only the first
 * N are fetched and the rest are returned in `missing[]` so the
 * caller's existing partial-result handling kicks in.
 *
 * Concurrency is bounded (default 3) to avoid bursting the upstream
 * and tripping any soft per-IP rate limits.
 */
// Spec "REALISTIC 500-STOCK THROUGHPUT" (2026-05):
//   - Default per-call cap raised 5 → 25 so each batch tick covers a
//     meaningful slice of the 500-symbol universe. With Tier A's
//     15-min cadence and 25-symbol batches, the full universe
//     refreshes in ~5 cycles (≈75 min) at ~1.7k calls/day — well
//     within the 70k monthly ceiling. Operators with tighter quota
//     can lower via INDIANAPI_EMULATED_BATCH_MAX. The previous
//     cap=5 default left 95% of the universe untouched per tick and
//     produced the production "coverage=11% overflow=16" log lines
//     the operator flagged.
//   - Concurrency raised 3 → 5 so the worker pool keeps the
//     rate-limiter chain saturated even when one symbol's /stock
//     call stalls. Bound stays low enough to avoid bursty IP-rate
//     limit trips.
const MAX_EMULATED_BATCH_SYMBOLS = Math.max(1, Number(process.env.INDIANAPI_EMULATED_BATCH_MAX) || 25);
const EMULATED_BATCH_CONCURRENCY = Math.max(1, Number(process.env.INDIANAPI_EMULATED_BATCH_CONCURRENCY) || 5);

export async function getBatchQuotes(
  symbols: string[],
  _exchange: 'NSE' | 'BSE' = 'NSE',
  signal?: AbortSignal,
): Promise<BatchQuoteResult> {
  if (!symbols || symbols.length === 0) return { snapshots: [], missing: [] };

  const clean = [...new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))];
  if (clean.length === 0) return { snapshots: [], missing: [] };

  // Cap the per-call symbol count. Anything over the cap is returned
  // as `missing` so the resolver can either accept the partial or
  // re-queue. This is the core protection against /stock fan-out
  // covering the full universe — see audit math in scripts/auditApiUsage.ts.
  const fetch = clean.slice(0, MAX_EMULATED_BATCH_SYMBOLS);
  const overflow = clean.slice(MAX_EMULATED_BATCH_SYMBOLS);

  const snapshots: MarketSnapshot[] = [];
  const missing: string[] = [...overflow];
  // Per-call latency capture for the [PERF] log below. Recorded inside
  // the worker so the slowest-symbol diagnostic survives even when the
  // overall batch races a wall-clock cap upstream.
  const perCallLatencyMs: number[] = [];
  const batchStartedAt = Date.now();

  // Concurrency-bounded fan-out. Promise.all on an unbounded list
  // would open 50 sockets at once and look like a burst to the
  // upstream's rate limiter. `getQuote` itself dedupes concurrent
  // calls for the same symbol via the module-scope inFlightQuotes
  // map, so the same symbol queued by another caller (rescore,
  // lifecycle, SSE) collapses to one HTTP request.
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= fetch.length) return;
      const sym = fetch[idx];
      const callStart = Date.now();
      try {
        const snap = await getQuote(sym, signal);
        perCallLatencyMs.push(Date.now() - callStart);
        if (snap.price > 0) {
          snapshots.push(snap);
        } else {
          // Upstream returned a row with no price — treat as a miss
          // so the caller falls back to cache for that symbol.
          missing.push(sym);
        }
      } catch (err) {
        perCallLatencyMs.push(Date.now() - callStart);
        log.warn('emulated batch: /stock failed for symbol', {
          symbol: sym,
          error: err instanceof Error ? err.message : String(err),
        });
        missing.push(sym);
      }
    }
  }
  const workers = Array.from(
    { length: Math.min(EMULATED_BATCH_CONCURRENCY, fetch.length) },
    () => worker(),
  );
  await Promise.all(workers);

  // Spec "FIX INDIANAPI TIMEOUT" §7 — [PERF] structured one-liner so
  // operators can grep the console for batch latency / coverage /
  // success-rate without flipping a verbose flag. Emitted regardless
  // of outcome so a 0% batch is just as visible as a 100% one.
  const batchTotalMs   = Date.now() - batchStartedAt;
  const successCount   = snapshots.length;
  const requestedCount = fetch.length;
  const successRate    = requestedCount > 0
    ? Math.round((successCount / requestedCount) * 100)
    : 0;
  const coverage       = clean.length > 0
    ? Math.round((successCount / clean.length) * 100)
    : 0;
  const avgLatencyMs   = perCallLatencyMs.length > 0
    ? Math.round(perCallLatencyMs.reduce((a, b) => a + b, 0) / perCallLatencyMs.length)
    : 0;
  const maxLatencyMs   = perCallLatencyMs.length > 0
    ? Math.max(...perCallLatencyMs) : 0;
  console.log(
    `[PERF] IndianAPI batch_total_ms=${batchTotalMs} requested=${requestedCount} ` +
    `success=${successCount} success_rate=${successRate}% coverage=${coverage}% ` +
    `avg_latency_ms=${avgLatencyMs} max_latency_ms=${maxLatencyMs} ` +
    `concurrency=${EMULATED_BATCH_CONCURRENCY} cap=${MAX_EMULATED_BATCH_SYMBOLS} ` +
    `overflow=${overflow.length}`,
  );

  if (overflow.length > 0) {
    // Spec "REALISTIC THROUGHPUT" (2026-05) — escalate to warn when
    // the cap is dropping more than half the requested symbols. This
    // is the production "coverage=11% overflow=16" condition the
    // operator flagged and surfaces it directly in the warn channel
    // instead of being buried in info logs.
    const dropRate = clean.length > 0 ? overflow.length / clean.length : 0;
    const payload = {
      requested: clean.length,
      fetched:   fetch.length,
      capped:    overflow.length,
      cap:       MAX_EMULATED_BATCH_SYMBOLS,
      drop_rate: Math.round(dropRate * 100),
      hint:      'raise INDIANAPI_EMULATED_BATCH_MAX or split caller into smaller batches',
    };
    if (dropRate >= 0.5) {
      log.warn('emulated batch: per-call cap is dropping >50% of requested symbols', payload);
    } else {
      log.info('emulated batch: capped per-call symbol count', payload);
    }
  }

  return { snapshots, missing };
}

/**
 * REMOVED — IndianAPI has no working intraday route on this plan.
 * Verified 2026-05-01: /intraday, /intraday_data, /intraday_quote,
 * /intraday_chart, /stock_intraday all 404. Kept as a stub so the
 * candle scheduler's optional intraday call site compiles; that
 * path already tolerates the throw and falls back to /historical_data.
 */
export async function getIntraday(symbols: string | string[]): Promise<unknown> {
  const arr = Array.isArray(symbols) ? symbols : [symbols];
  if (arr.length === 0 || arr.every(s => !s || !s.trim())) return [];
  return removedEndpoint('getIntraday');
}

interface RawBatchRow {
  symbol?: string;
  tickerId?: string;
  companyName?: string;
  price?: string | number;
  ltp?: string | number;
  lastPrice?: string | number;
  currentPrice?: { NSE?: string | number; BSE?: string | number } | string | number;
  percentChange?: string | number;
  change?: string | number;
  volume?: string | number;
  open?: string | number;
  dayHigh?: string | number;
  high?: string | number;
  dayLow?: string | number;
  low?: string | number;
  previousClose?: string | number;
  prevClose?: string | number;
  yearHigh?: string | number;
  yearLow?: string | number;
  timestamp?: string | number;
}

function mapBatchRow(r: RawBatchRow): MarketSnapshot | null {
  const sym = String(r.symbol ?? r.tickerId ?? '').trim().toUpperCase();
  if (!sym) return null;

  let price: number;
  if (typeof r.currentPrice === 'object' && r.currentPrice !== null) {
    price = num(r.currentPrice.NSE) || num(r.currentPrice.BSE);
  } else {
    price = num(r.currentPrice) || num(r.price) || num(r.ltp) || num(r.lastPrice);
  }
  const prevClose = num(r.previousClose ?? r.prevClose);
  const change = num(r.change) || (prevClose > 0 ? price - prevClose : 0);
  const changePct = num(r.percentChange) ||
    (prevClose > 0 ? (change / prevClose) * 100 : 0);

  return {
    symbol: sym,
    price,
    ltp: price,
    change,
    changePercent: changePct,
    volume: num(r.volume),
    open: num(r.open),
    high: num(r.dayHigh ?? r.high),
    low:  num(r.dayLow  ?? r.low),
    prevClose,
    timestamp: num(r.timestamp) || Date.now(),
  };
}

/**
 * Flat list of trending symbols (gainers ∪ losers). Reuses the
 * /trending endpoint since that's the one confirmed on our IndianAPI
 * plan; the old /trending_stocks path 404s. Cheaper than a separate
 * call — the trigger engine only needs the symbol set, not the full
 * gainer/loser payload.
 */
export async function getTrendingSymbols(signal?: AbortSignal): Promise<string[]> {
  const raw = await call<{
    trending_stocks?: { top_gainers?: RawStock[]; top_losers?: RawStock[] };
  }>(INDIANAPI_ENDPOINTS.trending, {}, signal);
  const symbols = new Set<string>();
  for (const s of raw.trending_stocks?.top_gainers ?? []) {
    const sym = String(s.tickerId ?? '').toUpperCase();
    if (sym) symbols.add(sym);
  }
  for (const s of raw.trending_stocks?.top_losers ?? []) {
    const sym = String(s.tickerId ?? '').toUpperCase();
    if (sym) symbols.add(sym);
  }
  return [...symbols];
}

/** GET /market_news  (VERIFY) — market-wide headlines. */
export async function getMarketNews(signal?: AbortSignal): Promise<NewsItem[]> {
  const raw = await call<{ news?: RawNewsRow[] } | RawNewsRow[]>(INDIANAPI_ENDPOINTS.marketNews, {}, signal);
  const list = Array.isArray(raw) ? raw : (raw.news ?? []);
  return list.map(mapNewsRow);
}

/** GET /stock_news?stock_name=<sym>  (VERIFY) — company-specific news. */
export async function getCompanyNews(symbol: string, signal?: AbortSignal): Promise<NewsItem[]> {
  const sym = symbol.trim().toUpperCase();
  const raw = await call<{ news?: RawNewsRow[] } | RawNewsRow[]>(
    INDIANAPI_ENDPOINTS.companyNews,
    { query: { stock_name: sym } },
    signal,
  );
  const list = Array.isArray(raw) ? raw : (raw.news ?? []);
  return list.map(r => ({ ...mapNewsRow(r), symbol: sym }));
}

/**
 * GET /ai_news?category=<cat>. The upstream REQUIRES the `category`
 * query param — omitting it (or passing an unknown category) returns
 * `{"Error":"Invalid category specified"}` with status 200, which
 * silently looks like "no news" and wastes a quota slot. Defaults to
 * 'economy' (verified 2026-05-01 to return real `articles[]`).
 * Response shape differs from /news: top-level `{ articles: [...] }`
 * with fields `headline`, `summary`, `published_at`, `image.url`.
 */
export async function getAiCuratedNews(category: string = 'economy', signal?: AbortSignal): Promise<NewsItem[]> {
  const raw = await call<{ articles?: RawNewsRow[]; news?: RawNewsRow[]; Error?: string } | RawNewsRow[]>(
    INDIANAPI_ENDPOINTS.aiCuratedNews,
    { query: { category } },
    signal,
  );
  if (!Array.isArray(raw) && raw.Error) {
    log.warn('ai_news returned error envelope', { category, error: raw.Error });
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw.articles ?? raw.news ?? []);
  return list.map(mapNewsRow);
}

interface RawNewsRow {
  symbol?: string;
  headline?: string;
  title?: string;
  source?: string;
  url?: string;
  link?: string;
  // /company_news shape (verified 2026-05-01)
  article_link?: string;
  source_link?: string;
  published?: string;
  // /news shape (verified 2026-05-01)
  pub_date?: string;
  image_url?: string;
  // /ai_news shape (verified 2026-05-01)
  published_at?: string | number;
  publishedAt?: string | number;
  date?: string;
  summary?: string;
  description?: string;
}

function mapNewsRow(r: RawNewsRow): NewsItem {
  const dateField =
    r.publishedAt ??
    r.published_at ??
    r.pub_date ??
    r.published ??
    r.date;
  const publishedAt = typeof dateField === 'number'
    ? dateField
    : (dateField ? Date.parse(String(dateField)) : Date.now());
  return {
    symbol:   r.symbol?.toUpperCase(),
    headline: String(r.headline ?? r.title ?? ''),
    source:   r.source,
    url:      r.url ?? r.link ?? r.article_link,
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
    summary:  r.summary ?? r.description,
  };
}
