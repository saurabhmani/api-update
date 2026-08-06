// ════════════════════════════════════════════════════════════════
//  NSE Historical Provider — OPT-IN FALLBACK FOR CANDLES
//
//  Hits www.nseindia.com/api/historical/cm/equity for daily OHLCV.
//  Used ONLY when IndianAPI fails AND NSE_HISTORICAL_FETCH_ENABLED=true.
//
//  Circuit policy (2026-08):
//    • HTTP 503/502/504 + network → transient soft failure with
//      bounded retries / short cooldown. NEVER IST-midnight.
//    • HTTP 403 / captcha / bot challenge → hard trip (short
//      configurable cooldown, default 15 min — not midnight).
//    • HTTP 429 → honor Retry-After when present; else soft backoff.
//    • One 503 does not disable the whole backfill day.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import type { Candle } from '@/lib/signal-engine';
import {
  logSymbolNormalizeIfChanged,
  normalizeNseUniverseSymbol,
} from '@/lib/marketData/providers/nseSymbolNormalize';

const log = logger.child({ component: 'nseHistoricalProvider' });

// ── Public envelope ────────────────────────────────────────────────

export interface NseHistoricalResult {
  ok:           boolean;
  candles:      Candle[];
  errorCode:    string | null;
  errorMessage: string | null;
  /** True when a hard block is active — callers should pause globally. */
  tripped:      boolean;
  /** True when rejection was local (open breaker) — no upstream call. */
  locallyBlocked?: boolean;
  latencyMs:    number;
  universeSymbol?: string;
  providerSymbol?: string;
  series?: string;
}

// ── Config ─────────────────────────────────────────────────────────

function envBool(name: string, fallback = false): boolean {
  const v = (process.env[name] ?? '').toLowerCase().trim();
  if (v === '') return fallback;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on')  return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return fallback;
}

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}

const NSE_HISTORICAL_ENABLED = () => envBool('NSE_HISTORICAL_FETCH_ENABLED', false);

export function isNseHistoricalFetchEnabled(): boolean {
  return NSE_HISTORICAL_ENABLED();
}

const NSE_REQUEST_TIMEOUT_MS = () => envNum('NSE_HISTORICAL_TIMEOUT_MS', 3_000, 30_000, 8_000);
const NSE_MIN_GAP_MS         = () => envNum('NSE_HISTORICAL_MIN_GAP_MS', 1_000, 60_000, 7_000);
const NSE_DAILY_CAP          = () => envNum('NSE_HISTORICAL_DAILY_CAP', 1, 500, 50);
const NSE_HISTORICAL_DAYS    = () => envNum('NSE_HISTORICAL_DAYS', 30, 730, 365);

/** Consecutive soft 5xx before opening the short circuit. */
const NSE_SOFT_FAILURE_THRESHOLD = () =>
  envNum('NSE_HISTORICAL_CIRCUIT_FAILURE_THRESHOLD', 1, 20, 3);
/** Soft-circuit cooldown (seconds). Default 60s — not IST midnight. */
const NSE_SOFT_COOLDOWN_MS = () =>
  envNum('NSE_HISTORICAL_CIRCUIT_COOLDOWN_SECONDS', 5, 3600, 60) * 1000;
/** Hard-block (403/captcha) cooldown. Default 15 min. */
const NSE_HARD_COOLDOWN_MS = () =>
  envNum('NSE_HISTORICAL_HARD_COOLDOWN_SECONDS', 60, 86_400, 900) * 1000;
const NSE_503_MAX_RETRIES = () =>
  envNum('NSE_HISTORICAL_503_MAX_RETRIES', 0, 8, 2);

// ── State (per-process) ────────────────────────────────────────────

let lastRequestAt = 0;
let trippedUntil  = 0;
let tripReason: string | null = null;
let consecutiveSoftFailures = 0;
let softBackoffUntilMs = 0;
let breakerTrips = 0;
let locallyBlocked = 0;
let upstreamRequests = 0;

const SOFT_BACKOFF_BASE_MS  = 5_000;
const SOFT_BACKOFF_MAX_MS   = 5 * 60_000;

function noteSoftFailure(): number {
  consecutiveSoftFailures += 1;
  const delay = Math.min(
    SOFT_BACKOFF_MAX_MS,
    SOFT_BACKOFF_BASE_MS * 2 ** (consecutiveSoftFailures - 1),
  );
  // Per-request retry delay only — do NOT freeze the whole provider
  // behind softBackoffUntilMs here. Global pause uses openCircuit().
  if (consecutiveSoftFailures >= NSE_SOFT_FAILURE_THRESHOLD()) {
    openCircuit('soft_5xx_threshold', NSE_SOFT_COOLDOWN_MS());
    consecutiveSoftFailures = 0;
  }
  return delay;
}

/** 429 / Retry-After: pause provider briefly without IST-midnight trip. */
function noteRateLimitBackoff(retryMs: number): void {
  softBackoffUntilMs = Math.max(softBackoffUntilMs, Date.now() + retryMs);
}

function noteSuccess(): void {
  consecutiveSoftFailures = 0;
  softBackoffUntilMs = 0;
}

function openCircuit(reason: string, cooldownMs: number): void {
  trippedUntil = Date.now() + cooldownMs;
  tripReason = reason;
  breakerTrips += 1;
  console.warn(
    `[NSE CIRCUIT] OPEN reason=${reason} cooldown_ms=${cooldownMs} ` +
    `resume_after=${new Date(trippedUntil).toISOString()} trips=${breakerTrips}`,
  );
}

function istDayKey(d = new Date()): string {
  const ms = d.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

let dailyKey   = '';
let dailyCount = 0;

function bumpDailyCount(): number {
  const k = istDayKey();
  if (k !== dailyKey) {
    dailyKey   = k;
    dailyCount = 0;
  }
  dailyCount += 1;
  return dailyCount;
}

function readDailyCount(): number {
  const k = istDayKey();
  if (k !== dailyKey) return 0;
  return dailyCount;
}

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 5 * 60_000);
  }
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) {
    return Math.min(Math.max(0, dateMs - Date.now()), 5 * 60_000);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms: number): number {
  return Math.floor(ms * (0.5 + Math.random() * 0.5));
}

// ── HTTP plumbing ──────────────────────────────────────────────────

const NSE_BASE = 'https://www.nseindia.com';
const HOME_URL = `${NSE_BASE}/`;
const HIST_PATH = (sym: string, series: string, fromDDMMYYYY: string, toDDMMYYYY: string) =>
  `${NSE_BASE}/api/historical/cm/equity` +
  `?symbol=${encodeURIComponent(sym)}` +
  `&series=[%22${encodeURIComponent(series)}%22]` +
  `&from=${fromDDMMYYYY}` +
  `&to=${toDDMMYYYY}`;

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':           'application/json,text/plain,*/*',
  'Accept-Language':  'en-US,en;q=0.9',
  'Referer':          HOME_URL,
  'X-Requested-With': 'XMLHttpRequest',
};

let cookieJar = '';
let cookieAt  = 0;
const COOKIE_TTL_MS = 30 * 60_000;

async function refreshCookie(): Promise<void> {
  if (cookieJar && Date.now() - cookieAt < COOKIE_TTL_MS) return;
  try {
    const res = await fetch(HOME_URL, {
      method: 'GET',
      headers: COMMON_HEADERS,
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

const BLOCK_BODY_MARKERS = [
  /access\s*denied/i,
  /captcha/i,
  /bot\s*detected/i,
];

function ddmmyyyy(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = d.getFullYear();
  return `${dd}-${mm}-${yy}`;
}

interface NseHistoricalRow {
  CH_TIMESTAMP?: string;
  CH_OPENING_PRICE?: number;
  CH_TRADE_HIGH_PRICE?: number;
  CH_TRADE_LOW_PRICE?: number;
  CH_CLOSING_PRICE?: number;
  CH_TOT_TRADED_QTY?: number;
}

function parseRows(raw: unknown): Candle[] {
  const arr: NseHistoricalRow[] = Array.isArray(raw)
    ? (raw as NseHistoricalRow[])
    : Array.isArray((raw as { data?: unknown })?.data)
      ? ((raw as { data: NseHistoricalRow[] }).data)
      : [];
  const out: Candle[] = [];
  for (const r of arr) {
    const ts = r.CH_TIMESTAMP ? new Date(r.CH_TIMESTAMP).toISOString() : null;
    const o  = Number(r.CH_OPENING_PRICE);
    const h  = Number(r.CH_TRADE_HIGH_PRICE);
    const l  = Number(r.CH_TRADE_LOW_PRICE);
    const c  = Number(r.CH_CLOSING_PRICE);
    const v  = Number(r.CH_TOT_TRADED_QTY);
    if (!ts) continue;
    if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    if (o <= 0 || h <= 0 || l <= 0 || c <= 0) continue;
    out.push({ ts, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
  }
  out.sort((a, b) => new Date(a.ts as string).getTime() - new Date(b.ts as string).getTime());
  return out;
}

export function isNseHistoricalCircuitOpen(): boolean {
  return trippedUntil > Date.now();
}

export function getNseHistoricalResumeAfterIso(): string | null {
  return isNseHistoricalCircuitOpen() ? new Date(trippedUntil).toISOString() : null;
}

export function resetNseHistoricalStateForTests(): void {
  lastRequestAt = 0;
  trippedUntil = 0;
  tripReason = null;
  consecutiveSoftFailures = 0;
  softBackoffUntilMs = 0;
  breakerTrips = 0;
  locallyBlocked = 0;
  upstreamRequests = 0;
  dailyKey = '';
  dailyCount = 0;
  cookieJar = '';
  cookieAt = 0;
}

/** Operator visibility into per-process state. */
export function getNseHistoricalState() {
  return {
    enabled:       NSE_HISTORICAL_ENABLED(),
    tripped:       trippedUntil > Date.now(),
    tripped_until: trippedUntil > 0 ? new Date(trippedUntil).toISOString() : null,
    trip_reason:   tripReason,
    soft_backoff_remaining_ms: Math.max(0, softBackoffUntilMs - Date.now()),
    consecutive_soft_failures: consecutiveSoftFailures,
    daily_used:    readDailyCount(),
    daily_cap:     NSE_DAILY_CAP(),
    breaker_trips: breakerTrips,
    locally_blocked: locallyBlocked,
    upstream_requests: upstreamRequests,
  };
}

async function fetchOnce(
  url: string,
  symbol: string,
  attempt: number,
): Promise<{ res: Response; text?: string } | NseHistoricalResult> {
  const t0 = Date.now();
  upstreamRequests += 1;
  const res = await fetch(url, {
    method:  'GET',
    headers: { ...COMMON_HEADERS, ...(cookieJar ? { Cookie: cookieJar } : {}) },
    signal:  AbortSignal.timeout(NSE_REQUEST_TIMEOUT_MS()),
  });

  // Hard auth / bot blocks
  if (res.status === 403) {
    openCircuit(`HTTP_403`, NSE_HARD_COOLDOWN_MS());
    const msg = `HTTP_403 (hard circuit ${NSE_HARD_COOLDOWN_MS()}ms)`;
    console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'HTTP_403',
      errorMessage: msg, tripped: true, latencyMs: Date.now() - t0,
    };
  }

  // Rate limit — honor Retry-After; do not trip until midnight
  if (res.status === 429) {
    const retryMs = parseRetryAfterMs(res) ?? noteSoftFailure();
    noteRateLimitBackoff(retryMs);
    const msg = `HTTP_429 retry_after_ms=${retryMs}`;
    console.warn(
      `[NSE FETCH RETRY] symbol=${symbol} attempt=${attempt} statusCode=429 ` +
      `waitMs=${retryMs} breakerFailureCount=${consecutiveSoftFailures}`,
    );
    console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'HTTP_429',
      errorMessage: msg, tripped: isNseHistoricalCircuitOpen(), latencyMs: Date.now() - t0,
    };
  }

  // Transient 502/503/504
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    const retryMs = parseRetryAfterMs(res) ?? jitter(
      Math.min(SOFT_BACKOFF_MAX_MS, SOFT_BACKOFF_BASE_MS * 2 ** attempt),
    );
    noteSoftFailure();
    console.warn(
      `[NSE FETCH RETRY] symbol=${symbol} attempt=${attempt} statusCode=${res.status} ` +
      `waitMs=${retryMs} breakerFailureCount=${consecutiveSoftFailures}`,
    );
    return {
      ok: false, candles: [], errorCode: `HTTP_${res.status}`,
      errorMessage: `transient_upstream_${res.status} waitMs=${retryMs}`,
      tripped: isNseHistoricalCircuitOpen(), latencyMs: Date.now() - t0,
      // attach wait hint via errorMessage for caller retry
    };
  }

  if (!res.ok) {
    noteSoftFailure();
    const msg = `HTTP_${res.status} ${res.statusText}`;
    console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: `HTTP_${res.status}`,
      errorMessage: msg, tripped: false, latencyMs: Date.now() - t0,
    };
  }

  return { res };
}

/**
 * Fetch ~1 year of daily OHLCV bars for `symbol` via NSE direct.
 */
export async function fetchNseHistoricalCandles(symbol: string): Promise<NseHistoricalResult> {
  const t0 = Date.now();
  const norm = normalizeNseUniverseSymbol(symbol);
  logSymbolNormalizeIfChanged(norm);

  if (!NSE_HISTORICAL_ENABLED()) {
    const msg = 'NSE_HISTORICAL_FETCH_ENABLED!=true (default-off)';
    console.warn(`[NSE FETCH FAIL] symbol=${norm.universeSymbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'DISABLED',
      errorMessage: msg, tripped: false, latencyMs: 0,
      universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
    };
  }

  if (trippedUntil > 0 && Date.now() < trippedUntil) {
    locallyBlocked += 1;
    const remainingMs = trippedUntil - Date.now();
    const msg = `circuit_open (${Math.round(remainingMs / 1000)}s remaining; reason=${tripReason ?? 'unknown'})`;
    console.warn(`[NSE FETCH FAIL] symbol=${norm.universeSymbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'CIRCUIT_OPEN',
      errorMessage: msg, tripped: true, locallyBlocked: true, latencyMs: 0,
      universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
    };
  }

  if (softBackoffUntilMs > 0 && Date.now() < softBackoffUntilMs) {
    const remainingMs = softBackoffUntilMs - Date.now();
    const msg = `soft_backoff (${Math.round(remainingMs / 1000)}s remaining)`;
    console.warn(`[NSE FETCH FAIL] symbol=${norm.universeSymbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'SOFT_BACKOFF',
      errorMessage: msg, tripped: false, locallyBlocked: true, latencyMs: 0,
      universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
    };
  }

  const cap = NSE_DAILY_CAP();
  const used = readDailyCount();
  if (used >= cap) {
    const msg = `daily_cap_hit (${used}/${cap})`;
    console.warn(`[NSE FETCH FAIL] symbol=${norm.universeSymbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'CAP_EXHAUSTED',
      errorMessage: msg, tripped: false, latencyMs: 0,
      universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
    };
  }

  const minGap = NSE_MIN_GAP_MS();
  const sinceLast = Date.now() - lastRequestAt;
  if (sinceLast < minGap) {
    await sleep(minGap - sinceLast);
  }

  await refreshCookie();

  const days = NSE_HISTORICAL_DAYS();
  const to   = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const url  = HIST_PATH(norm.providerSymbol, norm.series, ddmmyyyy(from), ddmmyyyy(to));

  const maxAttempts = 1 + NSE_503_MAX_RETRIES();
  let lastFail: NseHistoricalResult | null = null;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    lastRequestAt = Date.now();
    bumpDailyCount();

    try {
      const outcome = await fetchOnce(url, norm.universeSymbol, attempt + 1);
      if ('ok' in outcome) {
        lastFail = {
          ...outcome,
          universeSymbol: norm.universeSymbol,
          providerSymbol: norm.providerSymbol,
          series: norm.series,
        };
        // Retry only transient 5xx / 429
        const code = outcome.errorCode ?? '';
        const transient = code === 'HTTP_502' || code === 'HTTP_503' || code === 'HTTP_504' || code === 'HTTP_429';
        if (!transient || attempt >= maxAttempts - 1 || isNseHistoricalCircuitOpen()) {
          return lastFail;
        }
        const waitMatch = /waitMs=(\d+)/.exec(outcome.errorMessage ?? '');
        const waitMs = waitMatch ? Number(waitMatch[1]) : jitter(SOFT_BACKOFF_BASE_MS * 2 ** attempt);
        await sleep(waitMs);
        continue;
      }

      const { res } = outcome;
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) {
        openCircuit('BOT_CHALLENGE', NSE_HARD_COOLDOWN_MS());
        const peek = (await res.text().catch(() => '')).slice(0, 120);
        const msg  = `non-JSON response content-type="${ct.slice(0, 60)}" body="${peek.replace(/\s+/g, ' ').slice(0, 80)}"`;
        console.warn(`[NSE FETCH FAIL] symbol=${norm.universeSymbol} reason="${msg}"`);
        return {
          ok: false, candles: [], errorCode: 'BOT_CHALLENGE',
          errorMessage: msg, tripped: true, latencyMs: Date.now() - t0,
          universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
        };
      }

      const text = await res.text();
      for (const re of BLOCK_BODY_MARKERS) {
        if (re.test(text)) {
          openCircuit(`block_marker:${re.source}`, NSE_HARD_COOLDOWN_MS());
          const msg = `block_marker (${re.source})`;
          console.warn(`[NSE FETCH FAIL] symbol=${norm.universeSymbol} reason="${msg}"`);
          return {
            ok: false, candles: [], errorCode: 'BLOCK_MARKER',
            errorMessage: msg, tripped: true, latencyMs: Date.now() - t0,
            universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
          };
        }
      }

      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch (e) {
        noteSoftFailure();
        const msg = `parse_error: ${(e as Error).message}`;
        console.warn(`[NSE FETCH FAIL] symbol=${norm.universeSymbol} reason="${msg}"`);
        return {
          ok: false, candles: [], errorCode: 'PARSE_ERROR',
          errorMessage: msg, tripped: false, latencyMs: Date.now() - t0,
          universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
        };
      }

      const candles = parseRows(raw);
      if (candles.length === 0) {
        // Empty for this series is a symbol-level miss — do not trip breaker.
        const msg = norm.isSpecialSeries
          ? `unsupported_symbol_series series=${norm.series} (empty NSE payload)`
          : 'empty_payload (no parseable rows)';
        console.warn(`[NSE FETCH FAIL] symbol=${norm.universeSymbol} reason="${msg}"`);
        return {
          ok: false, candles: [],
          errorCode: norm.isSpecialSeries ? 'UNSUPPORTED_SERIES' : 'EMPTY_PAYLOAD',
          errorMessage: msg, tripped: false, latencyMs: Date.now() - t0,
          universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
        };
      }

      noteSuccess();
      const elapsed = Date.now() - t0;
      console.log(
        `[NSE FETCH SUCCESS] symbol=${norm.universeSymbol} providerSymbol=${norm.providerSymbol} ` +
        `series=${norm.series} bars=${candles.length} latency_ms=${elapsed}`,
      );
      return {
        ok: true, candles, errorCode: null,
        errorMessage: null, tripped: false, latencyMs: elapsed,
        universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
      };
    } catch (err) {
      const delay = noteSoftFailure();
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[NSE FETCH RETRY] symbol=${norm.universeSymbol} attempt=${attempt + 1} ` +
        `statusCode=network waitMs=${delay} breakerFailureCount=${consecutiveSoftFailures}`,
      );
      console.warn(`[NSE FETCH FAIL] symbol=${norm.universeSymbol} reason="network: ${msg}"`);
      lastFail = {
        ok: false, candles: [], errorCode: 'NETWORK',
        errorMessage: msg, tripped: isNseHistoricalCircuitOpen(), latencyMs: Date.now() - t0,
        universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
      };
      if (attempt >= maxAttempts - 1 || isNseHistoricalCircuitOpen()) return lastFail;
      await sleep(delay);
    }
  }

  return lastFail ?? {
    ok: false, candles: [], errorCode: 'UNKNOWN',
    errorMessage: 'exhausted retries', tripped: false, latencyMs: Date.now() - t0,
    universeSymbol: norm.universeSymbol, providerSymbol: norm.providerSymbol, series: norm.series,
  };
}
