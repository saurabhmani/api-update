// ════════════════════════════════════════════════════════════════
//  NSE Historical Provider — DEGRADED-MODE FALLBACK FOR CANDLES
//
//  Hits www.nseindia.com/api/historical/cm/equity for daily OHLCV
//  bars. Used by the candle fallback chain ONLY when:
//    1. The DB has < 100 bars for a symbol AND
//    2. IndianAPI live fetch failed/empty AND
//    3. NSE_HISTORICAL_FETCH_ENABLED=true is set in env.
//
//  Default OFF. NSE actively rate-limits and IP-bans unattended
//  scrapers, so this provider mirrors `nseDirectProvider`'s
//  conservative contract:
//    • Cookie acquisition before the API call (NSE 403s without it).
//    • Hard trip on 403/429/503/captcha — stays tripped until IST
//      midnight.
//    • Soft-failure exponential backoff (5s → 5min cap).
//    • Daily cap (default 50) — after that the provider is
//      "exhausted" until IST midnight. Counter is per-process; in
//      multi-instance deployments callers MUST coordinate via the
//      shared Redis key in nseDirectProvider if they want a
//      cluster-wide cap.
//    • Min 7 s gap between requests.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import type { Candle } from '@/lib/signal-engine';

const log = logger.child({ component: 'nseHistoricalProvider' });

// ── Public envelope ────────────────────────────────────────────────

export interface NseHistoricalResult {
  ok:           boolean;
  candles:      Candle[];
  errorCode:    string | null;
  errorMessage: string | null;
  /** True when NSE returned a hard block (403/429/captcha) and the
   *  provider should NOT be retried until IST midnight. */
  tripped:      boolean;
  latencyMs:    number;
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

// Spec "ENABLE NSE fallback" — default ON. Operators who hit
// NSE bot-blocks repeatedly can flip NSE_HISTORICAL_FETCH_ENABLED=false
// to take NSE out of the chain (the per-symbol provider trip + soft
// backoff already handle transient blocks without a kill switch).
const NSE_HISTORICAL_ENABLED = () => envBool('NSE_HISTORICAL_FETCH_ENABLED', true);
const NSE_REQUEST_TIMEOUT_MS = () => envNum('NSE_HISTORICAL_TIMEOUT_MS', 3_000, 30_000, 8_000);
const NSE_MIN_GAP_MS         = () => envNum('NSE_HISTORICAL_MIN_GAP_MS', 1_000, 60_000, 7_000);
const NSE_DAILY_CAP          = () => envNum('NSE_HISTORICAL_DAILY_CAP', 1, 500, 50);
const NSE_HISTORICAL_DAYS    = () => envNum('NSE_HISTORICAL_DAYS', 30, 730, 365);

// ── State (per-process) ────────────────────────────────────────────

let lastRequestAt = 0;
let trippedUntil  = 0;     // epoch ms; non-zero = blocked until that ms
let consecutiveSoftFailures = 0;
let backoffUntilMs          = 0;
const SOFT_BACKOFF_BASE_MS  = 5_000;
const SOFT_BACKOFF_MAX_MS   = 5 * 60_000;

// Daily cap counter — per-process (no Redis to keep the surface
// minimal; if needed, swap to cacheGet/cacheSet matching
// nseDirectProvider).
let dailyKey   = '';
let dailyCount = 0;

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
  const ms = d.getTime() + 5.5 * 60 * 60 * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

function nextIstMidnightMs(d = new Date()): number {
  const ms = d.getTime() + 5.5 * 60 * 60 * 1000;
  const ist = new Date(ms);
  ist.setUTCHours(24, 0, 0, 0);
  return ist.getTime() - 5.5 * 60 * 60 * 1000;
}

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

// ── HTTP plumbing ──────────────────────────────────────────────────

const NSE_BASE = 'https://www.nseindia.com';
const HOME_URL = `${NSE_BASE}/`;
// Daily OHLCV: NSE's historical endpoint. We pull a window (default
// ~365 days) so the engine has enough bars for ema200/sma200 plus
// some headroom.
const HIST_PATH = (sym: string, fromDDMMYYYY: string, toDDMMYYYY: string) =>
  `${NSE_BASE}/api/historical/cm/equity` +
  `?symbol=${encodeURIComponent(sym)}` +
  `&series=[%22EQ%22]` +
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
  /resource\s*not\s*found/i,
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
  // NSE wraps the array under `data` in modern responses.
  const arr: NseHistoricalRow[] = Array.isArray(raw)
    ? (raw as NseHistoricalRow[])
    : Array.isArray((raw as any)?.data)
      ? ((raw as any).data as NseHistoricalRow[])
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
  // ASC order — same convention as Phase 3.
  out.sort((a, b) => new Date(a.ts as any).getTime() - new Date(b.ts as any).getTime());
  return out;
}

// ── Public entry point ─────────────────────────────────────────────

/**
 * Fetch ~1 year of daily OHLCV bars for `symbol` via NSE direct.
 * Spec "FIX NSE FALLBACK" — emits [NSE FETCH SUCCESS] / [NSE FETCH FAIL]
 * loud-and-greppable so an operator can correlate what the chain saw.
 *
 * Returns a clean envelope; never throws. The fallback chain decides
 * whether to surface failure to the caller (typically: try the next
 * source).
 */
export async function fetchNseHistoricalCandles(symbol: string): Promise<NseHistoricalResult> {
  const t0 = Date.now();

  // Disabled by default. Operators must explicitly opt in.
  if (!NSE_HISTORICAL_ENABLED()) {
    const msg = 'NSE_HISTORICAL_FETCH_ENABLED!=true (default-off)';
    console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'DISABLED',
      errorMessage: msg, tripped: false, latencyMs: 0,
    };
  }

  // Hard-trip cooldown (403/429/captcha hit earlier in the day).
  if (trippedUntil > 0 && Date.now() < trippedUntil) {
    const remainingMs = trippedUntil - Date.now();
    const msg = `tripped (${Math.round(remainingMs / 1000)}s remaining)`;
    console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'TRIPPED',
      errorMessage: msg, tripped: true, latencyMs: 0,
    };
  }

  // Soft-failure backoff window.
  if (backoffUntilMs > 0 && Date.now() < backoffUntilMs) {
    const remainingMs = backoffUntilMs - Date.now();
    const msg = `soft_backoff (${Math.round(remainingMs / 1000)}s remaining)`;
    console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'SOFT_BACKOFF',
      errorMessage: msg, tripped: false, latencyMs: 0,
    };
  }

  // Daily cap.
  const cap = NSE_DAILY_CAP();
  const used = readDailyCount();
  if (used >= cap) {
    const msg = `daily_cap_hit (${used}/${cap})`;
    console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'CAP_EXHAUSTED',
      errorMessage: msg, tripped: false, latencyMs: 0,
    };
  }

  // Min-gap between requests (rate-limit friendliness).
  const minGap = NSE_MIN_GAP_MS();
  const sinceLast = Date.now() - lastRequestAt;
  if (sinceLast < minGap) {
    await new Promise((r) => setTimeout(r, minGap - sinceLast));
  }
  lastRequestAt = Date.now();

  await refreshCookie();
  bumpDailyCount();

  const days = NSE_HISTORICAL_DAYS();
  const to   = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  const url  = HIST_PATH(symbol, ddmmyyyy(from), ddmmyyyy(to));

  try {
    const res = await fetch(url, {
      method:  'GET',
      headers: { ...COMMON_HEADERS, ...(cookieJar ? { Cookie: cookieJar } : {}) },
      signal:  AbortSignal.timeout(NSE_REQUEST_TIMEOUT_MS()),
    });

    if (res.status === 403 || res.status === 429 || res.status === 503) {
      trippedUntil = nextIstMidnightMs();
      const msg = `HTTP_${res.status} (tripped until IST midnight)`;
      console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
      return {
        ok: false, candles: [], errorCode: `HTTP_${res.status}`,
        errorMessage: msg, tripped: true, latencyMs: Date.now() - t0,
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

    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      trippedUntil = nextIstMidnightMs();
      const peek = (await res.text().catch(() => '')).slice(0, 120);
      const msg  = `non-JSON response content-type="${ct.slice(0, 60)}" body="${peek.replace(/\s+/g, ' ').slice(0, 80)}"`;
      console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
      return {
        ok: false, candles: [], errorCode: 'BOT_CHALLENGE',
        errorMessage: msg, tripped: true, latencyMs: Date.now() - t0,
      };
    }

    const text = await res.text();
    for (const re of BLOCK_BODY_MARKERS) {
      if (re.test(text)) {
        trippedUntil = nextIstMidnightMs();
        const msg = `block_marker (${re.source})`;
        console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
        return {
          ok: false, candles: [], errorCode: 'BLOCK_MARKER',
          errorMessage: msg, tripped: true, latencyMs: Date.now() - t0,
        };
      }
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      noteSoftFailure();
      const msg = `parse_error: ${(e as Error).message}`;
      console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
      return {
        ok: false, candles: [], errorCode: 'PARSE_ERROR',
        errorMessage: msg, tripped: false, latencyMs: Date.now() - t0,
      };
    }

    const candles = parseRows(raw);
    if (candles.length === 0) {
      noteSoftFailure();
      const msg = 'empty_payload (no parseable rows)';
      console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${msg}"`);
      return {
        ok: false, candles: [], errorCode: 'EMPTY_PAYLOAD',
        errorMessage: msg, tripped: false, latencyMs: Date.now() - t0,
      };
    }

    noteSuccess();
    const elapsed = Date.now() - t0;
    console.log(`[NSE FETCH SUCCESS] symbol=${symbol} bars=${candles.length} latency_ms=${elapsed}`);
    return {
      ok: true, candles, errorCode: null,
      errorMessage: null, tripped: false, latencyMs: elapsed,
    };
  } catch (err) {
    noteSoftFailure();
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="network: ${msg}"`);
    return {
      ok: false, candles: [], errorCode: 'NETWORK',
      errorMessage: msg, tripped: false, latencyMs: Date.now() - t0,
    };
  }
}

/** Operator visibility into per-process state. Used by debugPipeline. */
export function getNseHistoricalState() {
  return {
    enabled:       NSE_HISTORICAL_ENABLED(),
    tripped:       trippedUntil > Date.now(),
    tripped_until: trippedUntil > 0 ? new Date(trippedUntil).toISOString() : null,
    soft_backoff_remaining_ms: Math.max(0, backoffUntilMs - Date.now()),
    daily_used:    readDailyCount(),
    daily_cap:     NSE_DAILY_CAP(),
  };
}
