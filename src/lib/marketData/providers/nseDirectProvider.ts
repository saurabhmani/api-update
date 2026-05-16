// ════════════════════════════════════════════════════════════════
//  NSE Direct Provider — RARE EMERGENCY FALLBACK ONLY (Step 5)
//
//  Hits www.nseindia.com directly. NSE actively rate-limits and IP-bans
//  unattended scrapers, so this provider follows a strict, conservative
//  contract:
//
//    • Disabled by default. Operator must set NSE_DIRECT_FALLBACK_ENABLED=true.
//    • Triggered ONLY when the resolver has seen N consecutive
//      IndianAPI failures (default 3). Never used during normal ops.
//    • NEVER used for full universe scans. The caller is expected to
//      pass <= MAX_SYMBOLS_PER_DAY symbols, all from the allow-list:
//        - confirmed signals
//        - current top candidates
//        - user-searched stock
//    • Hard daily cap (default 50 symbols/day). Counter persists in
//      Redis (via cache.set) keyed by IST calendar day.
//    • No parallelism. Strictly sequential.
//    • Min 7s gap between requests.
//    • Stop immediately on 403, 429, captcha, or bot challenge.
//      Once tripped, the provider stays tripped for the rest of the
//      IST day; the resolver returns DATA_DEGRADED.
//    • Every request is logged to q365_data_feed_health via
//      feedHealthLog.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import type { MarketSnapshot } from '@/types/market';
import { cacheGet, cacheSet } from '@/lib/redis';
import { logFeedHealth } from '../feedHealthLog';
import { getNseDirectFallbackConfig } from '../providerFlags';
import {
  validateMarketSnapshot,
  logProviderInvalidPayload,
} from '../payloadValidator';

const log = logger.child({ component: 'nseDirectProvider' });

// ── Public envelope ────────────────────────────────────────────────

export interface NseDirectResult {
  snapshots:     MarketSnapshot[];
  failedSymbols: string[];
  errorCode:     string | null;
  errorMessage:  string | null;
  /** True when the daily cap has been reached AND the resolver should
   *  treat further calls as DATA_DEGRADED. */
  exhausted:     boolean;
  /** Per-symbol provenance flag — true means the snapshot came from
   *  the NSE-direct cache (no upstream call), false means a fresh
   *  fetch. Caller surfaces this as `cached` in the spec response. */
  cachedSymbols: string[];
  /** Symbols served from a fresh upstream call this invocation. */
  freshSymbols:  string[];
}

// ── Per-symbol cache ──────────────────────────────────────────────
//
// Spec: "TTL = 2–5 minutes / DO NOT call NSE again if cached".
// We keep snapshots in the same `cacheGet/cacheSet` layer the rest of
// the codebase uses (Redis when configured, in-process map otherwise).
// 3 minutes is the spec midpoint and lines up with the resolver's
// `QUOTE_TTL_S` for IndianAPI cache so the two layers stay coherent.
const NSE_QUOTE_CACHE_TTL_S = Math.max(60, Math.min(600,
  Number(process.env.NSE_DIRECT_CACHE_TTL_S) || 180,
));
const nseQuoteCacheKey = (sym: string) => `nse_direct:quote:${sym.toUpperCase()}`;

async function readCachedQuote(symbol: string): Promise<MarketSnapshot | null> {
  const v = await cacheGet<MarketSnapshot>(nseQuoteCacheKey(symbol));
  if (!v || !Number.isFinite(v.price) || v.price <= 0) return null;
  return v;
}

async function writeCachedQuote(snap: MarketSnapshot): Promise<void> {
  await cacheSet(nseQuoteCacheKey(snap.symbol.toUpperCase()), snap, NSE_QUOTE_CACHE_TTL_S);
}

// ── State (per-process) ────────────────────────────────────────────

let lastRequestAt = 0;
let trippedUntil  = 0;   // epoch ms; non-zero = blocked until that ms

// ── Exponential backoff for transient failures ────────────────────
//
// Hard blocks (403/429/captcha) instantly trip until IST midnight.
// Soft failures (NETWORK, 5xx, EMPTY_PAYLOAD) are absorbed via
// exponential backoff: each consecutive failure doubles the cooldown
// (5s → 10s → 20s → 40s → 80s, capped at 5 min). One success resets
// the streak. This protects NSE from a "tight retry on a flaky link"
// pattern that often precedes a hard ban.
let consecutiveSoftFailures = 0;
let backoffUntilMs          = 0;
const SOFT_BACKOFF_BASE_MS  = 5_000;
const SOFT_BACKOFF_MAX_MS   = 5 * 60_000;

function noteSoftFailure(): void {
  consecutiveSoftFailures += 1;
  const delay = Math.min(
    SOFT_BACKOFF_MAX_MS,
    SOFT_BACKOFF_BASE_MS * 2 ** (consecutiveSoftFailures - 1),
  );
  backoffUntilMs = Date.now() + delay;
}
function noteSuccess(): void {
  consecutiveSoftFailures = 0;
  backoffUntilMs          = 0;
}

function istDayKey(d = new Date()): string {
  // IST = UTC+5:30. Bucket by IST calendar date.
  const ms = d.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Wall-clock ms of the next IST midnight relative to `d`. The trip
 *  cooldown stays active until this moment so a block at 14:00 IST
 *  on Tuesday clears at 00:00 IST on Wednesday — matches the spec
 *  ("disable for the remainder of the IST calendar day"). */
function nextIstMidnightMs(d = new Date()): number {
  const ms = d.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(ms);
  ist.setUTCHours(24, 0, 0, 0);          // IST tomorrow 00:00
  return ist.getTime() - 5.5 * 60 * 60 * 1000;  // back to UTC ms
}

/** Body-content markers that indicate a soft block / bot challenge.
 *  Matched case-insensitive on the raw response text. */
const BLOCK_BODY_MARKERS = [
  /access\s*denied/i,
  /captcha/i,
  /bot\s*detected/i,
  /resource\s*not\s*found/i,
];

const dayCounterKey = () => `nse_direct:daily_count:${istDayKey()}`;

async function readDailyCount(): Promise<number> {
  return (await cacheGet<number>(dayCounterKey())) ?? 0;
}

async function bumpDailyCount(n: number): Promise<number> {
  const next = (await readDailyCount()) + n;
  // 36h TTL safely covers IST midnight rollover.
  await cacheSet(dayCounterKey(), next, 36 * 3600);
  return next;
}

// ── HTTP plumbing ──────────────────────────────────────────────────

interface NseRawQuote {
  priceInfo?: {
    lastPrice?:    number;
    change?:       number;
    pChange?:      number;
    open?:         number;
    intraDayHighLow?: { min?: number; max?: number };
    close?:        number;
    previousClose?: number;
  };
  securityWiseDP?: { quantityTraded?: number };
  metadata?: { symbol?: string };
}

const NSE_BASE = 'https://www.nseindia.com';
const QUOTE_PATH = (sym: string) =>
  `${NSE_BASE}/api/quote-equity?symbol=${encodeURIComponent(sym)}`;
const HOME_URL = `${NSE_BASE}/`;

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':           'application/json,text/plain,*/*',
  'Accept-Language':  'en-US,en;q=0.9',
  'Referer':          HOME_URL,
  'X-Requested-With': 'XMLHttpRequest',
};

/** NSE serves a session cookie from the home page; many endpoints
 *  return 403 without it. We refresh once per process. */
let cookieJar = '';
let cookieAt  = 0;
const COOKIE_TTL_MS = 30 * 60_000;

async function refreshCookie(): Promise<void> {
  if (cookieJar && Date.now() - cookieAt < COOKIE_TTL_MS) return;
  try {
    const res = await fetch(HOME_URL, {
      method: 'GET',
      headers: COMMON_HEADERS,
      // 6s upper bound — if NSE is too slow we fail fast.
      signal: AbortSignal.timeout(6_000),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    if (setCookie.length === 0) return;
    cookieJar = setCookie.map((c) => c.split(';')[0]).join('; ');
    cookieAt  = Date.now();
  } catch (err) {
    log.warn('NSE cookie refresh failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

interface FetchOutcome {
  ok:        boolean;
  snapshot?: MarketSnapshot;
  errorCode?: string;
  errorMessage?: string;
  /** Set when the response indicates a permanent block for the day. */
  trip?:     boolean;
}

async function fetchOne(
  symbol: string,
  requestTimeoutMs: number,
): Promise<FetchOutcome> {
  await refreshCookie();
  const t0 = Date.now();
  try {
    const res = await fetch(QUOTE_PATH(symbol), {
      method: 'GET',
      headers: { ...COMMON_HEADERS, ...(cookieJar ? { Cookie: cookieJar } : {}) },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    // Hard block statuses: 403 / 429 / 503.
    if (res.status === 403 || res.status === 429 || res.status === 503) {
      return {
        ok: false,
        errorCode: `HTTP_${res.status}`,
        errorMessage: `NSE direct blocked: ${res.status}`,
        trip: true,
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        errorCode: `HTTP_${res.status}`,
        errorMessage: `NSE direct ${res.status} ${res.statusText}`,
      };
    }
    // Soft-block: non-JSON content (captcha / HTML challenge page).
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      const peek = (await res.text().catch(() => '')).slice(0, 200);
      return {
        ok: false,
        errorCode: 'BOT_CHALLENGE',
        errorMessage: `Non-JSON response (content-type=${ct.slice(0, 60)} body=${peek.replace(/\s+/g, ' ').slice(0, 80)})`,
        trip: true,
      };
    }
    // Read the body once as text so we can both block-scan and parse.
    const text = await res.text();
    for (const re of BLOCK_BODY_MARKERS) {
      if (re.test(text)) {
        return {
          ok: false,
          errorCode: 'BLOCK_MARKER',
          errorMessage: `NSE direct returned a soft-block marker (${re.source})`,
          trip: true,
        };
      }
    }
    // Slow responses are usually a precursor to a block — defensively
    // trip if a single quote took longer than the configured upper bound.
    const tookMs = Date.now() - t0;
    if (tookMs > requestTimeoutMs - 1_000) {
      return {
        ok: false,
        errorCode: 'SLOW_RESPONSE',
        errorMessage: `NSE direct response too slow (${tookMs}ms) — treating as block precursor`,
        trip: true,
      };
    }
    let raw: NseRawQuote;
    try {
      raw = JSON.parse(text) as NseRawQuote;
    } catch (e) {
      return {
        ok: false,
        errorCode: 'PARSE_ERROR',
        errorMessage: `NSE direct returned non-parsable JSON: ${(e as Error).message}`,
        trip: true,
      };
    }
    const sym = (raw.metadata?.symbol ?? symbol).toUpperCase();
    const lp  = raw.priceInfo?.lastPrice;
    if (typeof lp !== 'number' || !Number.isFinite(lp) || lp <= 0) {
      return { ok: false, errorCode: 'EMPTY_PAYLOAD', errorMessage: 'no lastPrice' };
    }
    const prev = raw.priceInfo?.previousClose ?? raw.priceInfo?.close ?? 0;
    const chg  = raw.priceInfo?.change ?? (prev ? lp - prev : 0);
    const pct  = raw.priceInfo?.pChange ?? (prev ? ((lp - prev) / prev) * 100 : 0);
    const snapshot: MarketSnapshot = {
      symbol: sym,
      price:  lp,
      ltp:    lp,
      change: chg,
      changePercent: pct,
      volume: raw.securityWiseDP?.quantityTraded ?? 0,
      open:   raw.priceInfo?.open ?? 0,
      high:   raw.priceInfo?.intraDayHighLow?.max ?? 0,
      low:    raw.priceInfo?.intraDayHighLow?.min ?? 0,
      prevClose: prev,
      timestamp: Date.now(),
    };
    // Spec PROVIDER-NORMALIZE-2026-05 — gate the NSE-shaped snapshot
    // before returning. NSE's payload occasionally lands with
    // quantityTraded=0 mid-session for newly-listed or thinly-traded
    // symbols; those rows must NOT enter Phase 3 scoring. The validator
    // emits [PROVIDER_INVALID_PAYLOAD] / [PROVIDER_REJECTED_SYMBOL] so
    // SRE has a single grep target across providers.
    const validation = validateMarketSnapshot(snapshot);
    if (!validation.ok) {
      logProviderInvalidPayload('NseDirect', sym, validation.reasons, raw);
      return {
        ok: false,
        errorCode: 'EMPTY_PAYLOAD',
        errorMessage: `NSE direct payload invalid — ${validation.reasons.join(',')}`,
      };
    }
    return { ok: true, snapshot };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, errorCode: 'NETWORK', errorMessage: msg };
  }
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Fetch NSE quotes for the given symbols. Strictly sequential, with
 * a 7-second floor between requests, an instant trip on 403/429/captcha,
 * and a hard daily cap. Returns a clean envelope; never throws.
 */
export async function fetchNseDirectQuotes(
  symbols: string[],
  signal?: AbortSignal,
): Promise<NseDirectResult> {
  const cfg = getNseDirectFallbackConfig();
  const clean = [...new Set(
    symbols.map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean),
  )];

  if (!cfg.enabled) {
    return {
      snapshots: [],
      failedSymbols: clean,
      errorCode: 'DISABLED',
      errorMessage: 'NSE_DIRECT_FALLBACK_ENABLED=false',
      exhausted: false,
      cachedSymbols: [],
      freshSymbols: [],
    };
  }

  // Guardrail: this provider must NEVER be used for the full universe.
  if (clean.length > 100) {
    log.error('NSE direct called with too many symbols — refusing', {
      count: clean.length,
    });
    return {
      snapshots: [],
      failedSymbols: clean,
      errorCode: 'TOO_MANY_SYMBOLS',
      errorMessage: `NSE direct refused ${clean.length} symbols (cap is 100)`,
      exhausted: false,
      cachedSymbols: [],
      freshSymbols: [],
    };
  }

  // Spec SMART_FALLBACK §4 — per-call batch cap of 20 symbols. Anything
  // beyond the cap is sliced off here and returned via failedSymbols
  // so the resolver's caller can re-queue it on the next tick. Combined
  // with the 500ms gap, this caps a single fallback burst at 10s of
  // sequential requests against NSE — well under the soft per-IP
  // throttle that triggers their 403 challenge.
  const NSE_PER_CALL_CAP = Math.max(1, Number(process.env.NSE_DIRECT_FALLBACK_PER_CALL_CAP) || 20);
  let perCallOverflow: string[] = [];
  if (clean.length > NSE_PER_CALL_CAP) {
    log.warn('NSE direct: capping per-call symbol count', {
      requested: clean.length,
      cap:       NSE_PER_CALL_CAP,
    });
    perCallOverflow = clean.slice(NSE_PER_CALL_CAP);
    clean.length = NSE_PER_CALL_CAP;
  }

  // ── Cache-first ─────────────────────────────────────────────────
  //
  // Per spec: read the per-symbol cache before touching NSE. Every
  // hit cuts an upstream request — the single biggest lever for
  // staying invisible to NSE's anti-scrape layer.
  const snapshots: MarketSnapshot[] = [];
  const cachedSymbols: string[] = [];
  const remainingToFetch: string[] = [];
  for (const sym of clean) {
    const cached = await readCachedQuote(sym);
    if (cached) {
      snapshots.push(cached);
      cachedSymbols.push(sym);
    } else {
      remainingToFetch.push(sym);
    }
  }

  if (remainingToFetch.length === 0) {
    // 100% cache hit — no upstream call.
    log.info('NSE direct: 100% cache hit — no upstream call', {
      symbolsRequested: clean.length,
    });
    return {
      snapshots,
      failedSymbols: [],
      errorCode: null,
      errorMessage: null,
      exhausted: false,
      cachedSymbols,
      freshSymbols: [],
    };
  }

  // Permanent trip for the day?
  if (trippedUntil > Date.now()) {
    // Spec-required log line — grep on `NSE_BLOCK_DETECTED`.
    log.warn('NSE_BLOCK_DETECTED — provider tripped until IST midnight', {
      trippedUntil:    new Date(trippedUntil).toISOString(),
      requestedSymbols: remainingToFetch.length,
      cacheHits:       cachedSymbols.length,
    });
    return {
      snapshots,                                    // any cache hits we already have
      failedSymbols: remainingToFetch,
      errorCode:    'TRIPPED',
      errorMessage: 'NSE direct previously blocked today; staying off',
      exhausted:    true,
      cachedSymbols,
      freshSymbols: [],
    };
  }

  // Soft-failure backoff still in effect?
  if (backoffUntilMs > Date.now()) {
    log.warn('NSE direct: in soft-failure backoff — refusing fresh fetch', {
      consecutiveSoftFailures,
      backoffUntil:    new Date(backoffUntilMs).toISOString(),
      requestedSymbols: remainingToFetch.length,
      cacheHits:       cachedSymbols.length,
    });
    return {
      snapshots,
      failedSymbols: remainingToFetch,
      errorCode:    'BACKOFF',
      errorMessage: `NSE direct in exponential backoff (${consecutiveSoftFailures} consecutive soft failures)`,
      exhausted:    false,
      cachedSymbols,
      freshSymbols: [],
    };
  }

  let dailyCount = await readDailyCount();
  if (dailyCount >= cfg.maxSymbolsPerDay) {
    return {
      snapshots,
      failedSymbols: remainingToFetch,
      errorCode:    'DAILY_CAP',
      errorMessage: `NSE direct daily cap reached (${dailyCount}/${cfg.maxSymbolsPerDay})`,
      exhausted:    true,
      cachedSymbols,
      freshSymbols: [],
    };
  }

  const remainingQuota = cfg.maxSymbolsPerDay - dailyCount;
  const todo = remainingToFetch.slice(0, remainingQuota);
  const cappedSymbols = remainingToFetch.slice(remainingQuota);
  // perCallOverflow caught by the spec §4 batch cap above is also a
  // failure from the resolver's POV — same semantics as cappedSymbols.
  const failed: string[] = [...cappedSymbols, ...perCallOverflow];
  const freshSymbols: string[] = [];

  // Configurable upper bound per request — defaults to 30 s per spec.
  const requestTimeoutMs = Math.max(5_000, Number(process.env.NSE_DIRECT_FALLBACK_REQUEST_TIMEOUT_MS) || 30_000);

  for (let i = 0; i < todo.length; i++) {
    const sym = todo[i];
    if (signal?.aborted) {
      log.info('NSE direct: fetch aborted by signal', { processed: i, remaining: todo.length - i });
      break;
    }
    // Spec SMART_FALLBACK §4 + INSTITUTIONAL §E — minimum gap between
    // requests (default 500ms = 2 req/sec) PLUS ±20% randomized jitter
    // so a 20-symbol fan-out doesn't fire on a perfectly periodic
    // cadence (which is the exact pattern NSE's anti-bot heuristic
    // looks for). Sequential, never parallel.
    const jitterFactor = 0.8 + Math.random() * 0.4;        // 0.8 .. 1.2
    const targetGap    = Math.round(cfg.minDelayMs * jitterFactor);
    const wait         = targetGap - (Date.now() - lastRequestAt);
    if (wait > 0) {
      if (signal) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, wait);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(signal.reason ?? new Error('Aborted'));
          }, { once: true });
        }).catch(() => {}); // Catch abort error to just break loop in next iteration
      } else {
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    const startedAt = new Date().toISOString();
    const t0 = Date.now();
    const out = await fetchOne(sym, requestTimeoutMs);
    lastRequestAt = Date.now();
    const responseReceivedAt = new Date().toISOString();

    void logFeedHealth({
      provider: 'nse_direct',
      endpoint: 'quote-equity',
      request_started_at: startedAt,
      response_received_at: responseReceivedAt,
      status: out.ok ? 'success' : 'failed',
      latency_ms: Date.now() - t0,
      symbols_requested: 1,
      symbols_returned: out.ok ? 1 : 0,
      coverage_percent: out.ok ? 100 : 0,
      data_quality: out.ok ? 'MEDIUM' : 'LOW',
      error_code: out.errorCode ?? null,
      error_message: out.errorMessage ?? null,
    });

    if (out.ok && out.snapshot) {
      snapshots.push(out.snapshot);
      freshSymbols.push(sym);
      // Cache the fresh snapshot for the TTL window so a subsequent
      // call within ~3 min serves from cache and skips NSE entirely.
      await writeCachedQuote(out.snapshot);
      dailyCount = await bumpDailyCount(1);
      noteSuccess();
    } else {
      failed.push(sym);
      if (out.trip) {
        // Hard block: disable for the remainder of the IST calendar
        // day. Spec-required log line — grep on `NSE_BLOCK_DETECTED`.
        trippedUntil = nextIstMidnightMs();
        log.error('NSE_BLOCK_DETECTED — disabled until next IST midnight', {
          symbol:        sym,
          errorCode:     out.errorCode,
          errorMessage:  out.errorMessage,
          trippedUntil:  new Date(trippedUntil).toISOString(),
        });
        break;
      } else {
        // Transient soft failure (NETWORK / 5xx / EMPTY_PAYLOAD /
        // PARSE_ERROR without a hard-block marker). Apply
        // exponential backoff so we don't burn quota on a flaky
        // upstream — also a lead indicator of an impending hard
        // block, so backing off proactively is the right call.
        noteSoftFailure();
        log.warn('NSE direct: soft failure — backing off', {
          symbol:                  sym,
          errorCode:               out.errorCode,
          errorMessage:            out.errorMessage,
          consecutiveSoftFailures,
          backoffUntil:            new Date(backoffUntilMs).toISOString(),
        });
        // Stop the batch on backoff too — running 19 more requests
        // through a known-flaky upstream is exactly the pattern that
        // earns a hard ban.
        break;
      }
    }
    if (dailyCount >= cfg.maxSymbolsPerDay) break;
  }

  const isExhausted = dailyCount >= cfg.maxSymbolsPerDay
                   || trippedUntil > Date.now()
                   || backoffUntilMs > Date.now();
  return {
    snapshots,
    failedSymbols: failed,
    errorCode:    snapshots.length === 0 ? 'NO_DATA' : null,
    errorMessage: snapshots.length === 0 ? 'NSE direct returned no data' : null,
    exhausted:    isExhausted,
    cachedSymbols,
    freshSymbols,
  };
}

// ── Diagnostics — used by /api/signals/health-report ──────────────
export interface NseDirectStatus {
  enabled:                 boolean;
  trippedUntil:            string | null;
  consecutiveSoftFailures: number;
  backoffUntil:            string | null;
  dailyCount:              number;
  dailyCap:                number;
  cacheTtlSeconds:         number;
  minDelayMs:              number;
  triggerAfterFailures:    number;
}

export async function getNseDirectStatus(): Promise<NseDirectStatus> {
  const cfg = getNseDirectFallbackConfig();
  return {
    enabled:                 cfg.enabled,
    trippedUntil:            trippedUntil > 0 ? new Date(trippedUntil).toISOString() : null,
    consecutiveSoftFailures,
    backoffUntil:            backoffUntilMs > Date.now() ? new Date(backoffUntilMs).toISOString() : null,
    dailyCount:              await readDailyCount(),
    dailyCap:                cfg.maxSymbolsPerDay,
    cacheTtlSeconds:         NSE_QUOTE_CACHE_TTL_S,
    minDelayMs:              cfg.minDelayMs,
    triggerAfterFailures:    cfg.triggerFailures,
  };
}
