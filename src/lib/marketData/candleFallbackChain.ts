// ════════════════════════════════════════════════════════════════
//  Candle Fallback Chain — DB → Kite → IndianAPI → NSE (opt-in)
//
//  Provider priority for daily OHLCV (Phase 6):
//    1. DB cache (market_data_daily) — always first; during an active
//       pipeline scan (`isInFlight()`), evaluation reads are DB-only
//       so strategy evaluation never burns vendor quota.
//    2. Kite (`KiteAdapter.getHistorical` via kiteHistoricalProvider)
//       — primary upstream for backfill / incremental refresh.
//    3. IndianAPI (`getHistorical`) — fallback when Kite fails
//       (auth / rate-limit / empty / not configured).
//    4. NSE direct historical — fallback ONLY when
//       NSE_HISTORICAL_FETCH_ENABLED=true.
//    5. DB thin — return whatever rows exist.
//    6. Throw `CANDLE_NO_DATA`.
//
//  `refreshDailyCandles` → `getCandles` uses the upstream ingest path.
//  Phase 3/4 `fetchDailyCandlesWithFallback` uses DB-only while a scan
//  is in flight.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { Candle } from '@/lib/signal-engine';
import { getHistorical as getIndianApiHistorical } from '@/lib/marketData/providers/indianApiProvider';
import {
  getHistorical as getKiteHistorical,
  isKiteHistoricalConfigured,
} from '@/lib/marketData/providers/kiteHistoricalProvider';
import {
  fetchNseHistoricalCandles,
  isNseHistoricalFetchEnabled,
} from '@/lib/marketData/providers/nseHistoricalProvider';
import type { HistoricalRange } from '@/types/market';
import { getIndianApiConfig } from '@/lib/marketData/providers/indianApiEndpoints';
import { isInFlight } from '@/lib/scanner/scannerState';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import { resolveMarketCandles } from '@/lib/marketData/resolveMarketCandles';

// ── Config ─────────────────────────────────────────────────────────

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}

/** Minimum bar count for the DB fast-path during strategy evaluation. */
const MIN_BAR_THRESHOLD = () => envNum('CANDLE_MIN_BAR_THRESHOLD', 30, 500, 100);

/** Bar depth above which ingest skips upstream unless incremental refresh. */
export const SUFFICIENT_BAR_DEPTH = () =>
  envNum('CANDLE_SUFFICIENT_DEPTH', 30, 500, 100);

const DB_BARS_LIMIT = 300;

// ── Per-run source counters ────────────────────────────────────────

let _nseUsed = 0;
let _apiUsed = 0;
let _kiteUsed = 0;
let _dbUsed  = 0;
let _failed  = 0;
let _indianApiRequestCount = 0;
let _kiteRequestCount = 0;

export function resetCandleSourceCounters(): void {
  _nseUsed = 0;
  _apiUsed = 0;
  _kiteUsed = 0;
  _dbUsed  = 0;
  _failed  = 0;
  _indianApiRequestCount = 0;
  _kiteRequestCount = 0;
}

export function getCandleSourceCounters(): {
  nse_used: number;
  api_used: number;
  kite_used: number;
  db_used: number;
  failed: number;
  indianapi_requests: number;
  kite_requests: number;
} {
  return {
    nse_used: _nseUsed,
    api_used: _apiUsed,
    kite_used: _kiteUsed,
    db_used: _dbUsed,
    failed: _failed,
    indianapi_requests: _indianApiRequestCount,
    kite_requests: _kiteRequestCount,
  };
}

export function getIndianApiCandleRequestCount(): number {
  return _indianApiRequestCount;
}

export function getKiteCandleRequestCount(): number {
  return _kiteRequestCount;
}

// ── Public types ───────────────────────────────────────────────────

export type CandleSource = 'db' | 'kite' | 'indianapi' | 'nse' | 'db-thin';

export type IndianApiCandleErrorCode =
  | 'API_KEY_MISSING'
  | 'API_KEY_INVALID'
  | 'RATE_LIMITED'
  | 'UPSTREAM_5XX'
  | 'UPSTREAM_ERROR'
  | 'EMPTY_RESPONSE'
  | 'MALFORMED_RESPONSE'
  | 'BUDGET_EXCEEDED'
  | 'MARKET_CLOSED'
  | 'BUDGET_THROTTLED'
  | 'KITE_NOT_CONFIGURED'
  | 'KiteAuthenticationError'
  | 'KiteRateLimitError';

export interface CandleFetchResult {
  candles: Candle[];
  source: CandleSource;
  hitUpstream: boolean;
  latencyMs: number;
}

export interface DailyCandleFetchOptions {
  /** When true, allow upstream even if DB already has sufficient depth. */
  incrementalRefresh?: boolean;
  /** When true, never call upstream (DB-only). Overrides scan detection. */
  dbOnly?: boolean;
  /** When true, treat as pipeline scan read — DB-only if in flight. */
  evaluationRead?: boolean;
}

export interface IndianApiCandleFetchResult {
  ok: boolean;
  candles: Candle[];
  errorCode: IndianApiCandleErrorCode | string | null;
  errorMessage: string | null;
  rawBarCount: number;
  validBarCount: number;
  /** Which upstream filled this result (jobs/tests). */
  provider?: 'kite' | 'indianapi' | null;
}

// ── DB helpers ─────────────────────────────────────────────────────

export async function readDailyCandlesFromDb(symbol: string): Promise<Candle[]> {
  const result = await db.query(
    `SELECT ts, open, high, low, close, volume FROM (
       SELECT ts, open, high, low, close, volume
       FROM market_data_daily
       WHERE symbol = ?
       ORDER BY ts DESC
       LIMIT ?
     ) t
     ORDER BY ts ASC`,
    [symbol.toUpperCase(), DB_BARS_LIMIT],
  );
  return (result.rows as any[]).map((r) => ({
    ts: r.ts,
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

export async function getDbBarCount(symbol: string): Promise<number> {
  try {
    const { rows } = await db.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM market_data_daily WHERE symbol = ?`,
      [symbol.toUpperCase()],
    );
    return Number((rows[0] as any)?.cnt) || 0;
  } catch {
    return 0;
  }
}

function logIndianApiCandleRequest(symbol: string, endpoint: string): void {
  _indianApiRequestCount += 1;
  console.log(
    `[INDIANAPI REQUEST] endpoint=${endpoint} symbol=${symbol} ` +
    `request_count=${_indianApiRequestCount}`,
  );
}

function logKiteCandleRequest(symbol: string, endpoint: string): void {
  _kiteRequestCount += 1;
  console.log(
    `[KITE REQUEST] endpoint=${endpoint} symbol=${symbol} ` +
    `request_count=${_kiteRequestCount}`,
  );
}

function mapProviderErrorCode(
  errorCode: string | null | undefined,
  status?: number,
): IndianApiCandleErrorCode | string {
  const code = (errorCode ?? '').toUpperCase();
  if (code === 'API_KEY_MISSING' || code.includes('NOT_CONFIGURED') || code === 'KITE_NOT_CONFIGURED') {
    return code === 'KITE_NOT_CONFIGURED' ? 'KITE_NOT_CONFIGURED' : 'API_KEY_MISSING';
  }
  if (
    code === 'API_KEY_INVALID' || code === 'HTTP_403' || code === 'HTTP_401'
    || code.includes('AUTH') || code === 'KITEAUTHENTICATIONERROR'
  ) {
    return code.includes('KITE') || code === 'KITEAUTHENTICATIONERROR'
      ? 'KiteAuthenticationError'
      : 'API_KEY_INVALID';
  }
  if (
    code === 'HTTP_429' || code.includes('RATE') || code.includes('429')
    || code === 'KITERATELIMITERROR'
  ) {
    return code.includes('KITE') || code === 'KITERATELIMITERROR'
      ? 'KiteRateLimitError'
      : 'RATE_LIMITED';
  }
  if (code === 'BUDGET_EXHAUSTED' || code === 'API_BUDGET_EXCEEDED') return 'BUDGET_EXCEEDED';
  if (code.includes('PER_RUN') || code.includes('PER_RUN_LIMIT')) return 'BUDGET_EXCEEDED';
  if (code === 'BUDGET_THROTTLED') return 'BUDGET_THROTTLED';
  if (code === 'MARKET_CLOSED') return 'MARKET_CLOSED';
  if (code === 'EMPTY_RESPONSE' || code === 'UPSTREAM_NULL') return 'EMPTY_RESPONSE';
  if (code === 'MALFORMED_RESPONSE') return 'MALFORMED_RESPONSE';
  if (status != null && status >= 500 && status < 600) return 'UPSTREAM_5XX';
  if (code.startsWith('HTTP_5')) return 'UPSTREAM_5XX';
  // Preserve original casing for known Kite error names from the provider.
  if (
    errorCode === 'KiteAuthenticationError'
    || errorCode === 'KiteRateLimitError'
    || errorCode === 'KITE_NOT_CONFIGURED'
  ) {
    return errorCode;
  }
  return errorCode ?? 'UPSTREAM_ERROR';
}

function normalizeHistoricalCandles(
  raw: Array<{ t: number; o: number; h: number; l: number; c: number; v?: number }>,
): { candles: Candle[]; rawBarCount: number; validBarCount: number } {
  const rawBarCount = raw.length;
  const candles: Candle[] = [];
  for (const c of raw) {
    if (
      !Number.isFinite(c.t) || !Number.isFinite(c.o) || !Number.isFinite(c.h)
      || !Number.isFinite(c.l) || !Number.isFinite(c.c)
    ) continue;
    if (c.o <= 0 || c.h <= 0 || c.l <= 0 || c.c <= 0) continue;
    candles.push({
      ts: new Date(c.t).toISOString(),
      open: c.o,
      high: c.h,
      low: c.l,
      close: c.c,
      volume: Number.isFinite(c.v) ? (c.v as number) : 0,
    });
  }
  candles.sort(
    (a, b) => new Date(a.ts as string).getTime() - new Date(b.ts as string).getTime(),
  );
  return { candles, rawBarCount, validBarCount: candles.length };
}

/**
 * Fetch daily bars from KiteAdapter (via kiteHistoricalProvider).
 * Never throws — maps failures into IndianApiCandleFetchResult codes.
 */
export async function fetchKiteDailyCandles(
  symbol: string,
  range: HistoricalRange = '1y',
): Promise<IndianApiCandleFetchResult> {
  const sym = symbol.toUpperCase();
  const endpoint = `kite.historical:${range}`;

  if (!isKiteHistoricalConfigured()) {
    return {
      ok: false,
      candles: [],
      errorCode: 'KITE_NOT_CONFIGURED',
      errorMessage: 'KITE_API_KEY / KITE_ACCESS_TOKEN not set',
      rawBarCount: 0,
      validBarCount: 0,
      provider: 'kite',
    };
  }

  logKiteCandleRequest(sym, endpoint);

  try {
    const inv = await getKiteHistorical(sym, range);
    if (inv.status !== 'success' || !inv.data) {
      const code = mapProviderErrorCode(inv.errorCode);
      console.warn(
        `[KITE FETCH FAIL] symbol=${sym} code=${code} reason="${inv.errorMessage ?? ''}"`,
      );
      return {
        ok: false,
        candles: [],
        errorCode: code,
        errorMessage: inv.errorMessage,
        rawBarCount: 0,
        validBarCount: 0,
        provider: 'kite',
      };
    }

    const raw = inv.data.candles ?? [];
    if (raw.length === 0) {
      return {
        ok: false,
        candles: [],
        errorCode: 'EMPTY_RESPONSE',
        errorMessage: 'Kite returned zero candles',
        rawBarCount: 0,
        validBarCount: 0,
        provider: 'kite',
      };
    }

    const { candles, rawBarCount, validBarCount } = normalizeHistoricalCandles(raw);
    if (validBarCount === 0) {
      return {
        ok: false,
        candles: [],
        errorCode: 'MALFORMED_RESPONSE',
        errorMessage: `All ${rawBarCount} Kite bars failed validation`,
        rawBarCount,
        validBarCount: 0,
        provider: 'kite',
      };
    }

    _kiteUsed++;
    console.log(
      `[KITE FETCH OK] symbol=${sym} bars=${validBarCount} raw_bars=${rawBarCount}`,
    );
    return {
      ok: true,
      candles,
      errorCode: null,
      errorMessage: null,
      rawBarCount,
      validBarCount,
      provider: 'kite',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[KITE FETCH FAIL] symbol=${sym} code=UPSTREAM_ERROR reason="${msg}"`);
    return {
      ok: false,
      candles: [],
      errorCode: 'UPSTREAM_ERROR',
      errorMessage: msg,
      rawBarCount: 0,
      validBarCount: 0,
      provider: 'kite',
    };
  }
}

/**
 * Fetch daily bars from IndianAPI for ingest/backfill. Never used from
 * strategy evaluation — callers must gate on `isInFlight()` / `dbOnly`.
 */
export async function fetchIndianApiDailyCandles(
  symbol: string,
  range: HistoricalRange = '1y',
): Promise<IndianApiCandleFetchResult> {
  const sym = symbol.toUpperCase();
  const endpoint = `historical_data:${range}`;

  const { apiKey } = getIndianApiConfig();
  if (!apiKey) {
    console.warn(`[INDIANAPI FETCH FAIL] symbol=${sym} reason=API_KEY_MISSING`);
    return {
      ok: false,
      candles: [],
      errorCode: 'API_KEY_MISSING',
      errorMessage: 'INDIANAPI_API_KEY (or INDIANAPI_KEY / INDIAN_API_KEY) is not set',
      rawBarCount: 0,
      validBarCount: 0,
      provider: 'indianapi',
    };
  }

  logIndianApiCandleRequest(sym, endpoint);

  try {
    const inv = await getIndianApiHistorical(sym, range);
    const mappedCode = mapProviderErrorCode(inv.errorCode ?? undefined);

    if (inv.status !== 'success' && inv.status !== 'partial') {
      const msg = inv.errorMessage ?? `provider status=${inv.status}`;
      console.warn(`[INDIANAPI FETCH FAIL] symbol=${sym} code=${mappedCode} reason="${msg}"`);
      return {
        ok: false,
        candles: [],
        errorCode: mappedCode,
        errorMessage: msg,
        rawBarCount: 0,
        validBarCount: 0,
        provider: 'indianapi',
      };
    }

    const series = inv.data;
    const raw = series?.candles ?? [];
    if (raw.length === 0) {
      console.warn(`[INDIANAPI FETCH FAIL] symbol=${sym} code=EMPTY_RESPONSE`);
      return {
        ok: false,
        candles: [],
        errorCode: 'EMPTY_RESPONSE',
        errorMessage: 'IndianAPI returned zero candles',
        rawBarCount: 0,
        validBarCount: 0,
        provider: 'indianapi',
      };
    }

    const { candles, rawBarCount, validBarCount } = normalizeHistoricalCandles(raw);
    if (validBarCount === 0) {
      console.warn(
        `[INDIANAPI FETCH FAIL] symbol=${sym} code=MALFORMED_RESPONSE ` +
        `raw_bars=${rawBarCount}`,
      );
      return {
        ok: false,
        candles: [],
        errorCode: 'MALFORMED_RESPONSE',
        errorMessage: `All ${rawBarCount} upstream bars failed validation`,
        rawBarCount,
        validBarCount: 0,
        provider: 'indianapi',
      };
    }

    _apiUsed++;
    console.log(
      `[INDIANAPI FETCH OK] symbol=${sym} bars=${validBarCount} ` +
      `raw_bars=${rawBarCount}`,
    );
    return {
      ok: true,
      candles,
      errorCode: null,
      errorMessage: null,
      rawBarCount,
      validBarCount,
      provider: 'indianapi',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[INDIANAPI FETCH FAIL] symbol=${sym} code=UPSTREAM_ERROR reason="${msg}"`);
    return {
      ok: false,
      candles: [],
      errorCode: 'UPSTREAM_ERROR',
      errorMessage: msg,
      rawBarCount: 0,
      validBarCount: 0,
      provider: 'indianapi',
    };
  }
}

/**
 * Phase 6 upstream: Kite → IndianAPI.
 * Preserves the IndianApiCandleFetchResult contract for jobs/scripts.
 */
export async function fetchUpstreamDailyCandles(
  symbol: string,
  range: HistoricalRange = '1y',
): Promise<IndianApiCandleFetchResult> {
  const kite = await fetchKiteDailyCandles(symbol, range);
  if (kite.ok && kite.candles.length > 0) {
    return kite;
  }

  console.warn(
    `[CANDLE UPSTREAM] Kite miss symbol=${symbol.toUpperCase()} ` +
    `code=${kite.errorCode ?? 'unknown'} — trying IndianAPI`,
  );

  const ia = await fetchIndianApiDailyCandles(symbol, range);
  if (ia.ok && ia.candles.length > 0) {
    return ia;
  }

  // Prefer the more specific Kite failure when IndianAPI also failed
  // with a config miss and Kite was attempted (auth/rate-limit tests).
  if (
    kite.errorCode
    && kite.errorCode !== 'KITE_NOT_CONFIGURED'
    && (ia.errorCode === 'API_KEY_MISSING' || !ia.errorCode)
  ) {
    return kite;
  }
  return {
    ...ia,
    errorCode: ia.errorCode ?? kite.errorCode,
    errorMessage: ia.errorMessage ?? kite.errorMessage,
  };
}

// ── DB upsert ──────────────────────────────────────────────────────

async function upsertToDb(symbol: string, candles: Candle[]): Promise<void> {
  if (candles.length === 0) return;
  try {
    const values: unknown[] = [];
    const placeholders: string[] = [];
    for (const c of candles) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?)');
      values.push(symbol.toUpperCase(), c.ts, c.open, c.high, c.low, c.close, c.volume);
    }
    await db.query(
      `INSERT INTO market_data_daily (symbol, ts, open, high, low, close, volume)
       VALUES ${placeholders.join(',')}
       ON DUPLICATE KEY UPDATE
         open=VALUES(open), high=VALUES(high), low=VALUES(low),
         close=VALUES(close), volume=VALUES(volume)`,
      values,
    );
  } catch (err) {
    console.warn(
      `[CANDLE UPSERT FAIL] symbol=${symbol} bars=${candles.length} ` +
      `reason="${(err as Error)?.message ?? String(err)}"`,
    );
  }
}

function shouldUseDbOnly(opts: DailyCandleFetchOptions): boolean {
  if (opts.dbOnly) return true;
  if (opts.evaluationRead !== false && isInFlight()) return true;
  return false;
}

// ── Strategy evaluation read path ──────────────────────────────────

/**
 * Fetch daily OHLCV for strategy evaluation. While a scan is running,
 * returns DB cache only — never calls IndianAPI or NSE.
 */
export async function fetchDailyCandlesWithFallback(
  symbol: string,
  opts: DailyCandleFetchOptions = {},
): Promise<CandleFetchResult> {
  const t0 = Date.now();
  const min = MIN_BAR_THRESHOLD();
  const sym = symbol.toUpperCase();
  const dbOnly = shouldUseDbOnly({ ...opts, evaluationRead: true });

  // Market-open: warehouse history + in-memory live session bar (no upstream).
  if (isMarketOpen()) {
    try {
      const live = await resolveMarketCandles(sym, {
        forceDaily: false,
        quiet: true,
      });
      if (live.candles.length >= (dbOnly ? 1 : min)) {
        _dbUsed++;
        console.log(
          `[CANDLE SOURCE] symbol=${sym} mode=live_session ` +
          `source=${live.source} bars=${live.candles.length} feed=${live.feedQuality}`,
        );
        return {
          candles:     live.candles,
          source:      'db',
          hitUpstream: false,
          latencyMs:   Date.now() - t0,
        };
      }
    } catch (err) {
      console.warn(
        `[CANDLE] live session merge failed for ${sym}: ` +
        `${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  let dbRows = await readDailyCandlesFromDb(sym).catch((err) => {
    console.warn(
      `[CANDLE ERROR] db read failed for ${sym}: ${(err as Error)?.message ?? String(err)}`,
    );
    return [] as Candle[];
  });

  if (dbOnly) {
    if (dbRows.length >= min) {
      _dbUsed++;
      console.log(`[CANDLE SOURCE] symbol=${sym} source=db bars=${dbRows.length} mode=scan_db_only`);
      return { candles: dbRows, source: 'db', hitUpstream: false, latencyMs: Date.now() - t0 };
    }
    if (dbRows.length > 0) {
      _dbUsed++;
      console.log(`[CANDLE SOURCE] symbol=${sym} source=db-thin bars=${dbRows.length} mode=scan_db_only`);
      return { candles: dbRows, source: 'db-thin', hitUpstream: false, latencyMs: Date.now() - t0 };
    }
    _failed++;
    throw new Error(
      `CANDLE_NO_DATA symbol=${sym} mode=scan_db_only db_bars=0 ` +
      `(upstream suppressed during active scan — run candle ingest first)`,
    );
  }

  if (dbRows.length >= min) {
    _dbUsed++;
    console.log(`[CANDLE SOURCE] symbol=${sym} source=db bars=${dbRows.length}`);
    return { candles: dbRows, source: 'db', hitUpstream: false, latencyMs: Date.now() - t0 };
  }

  if (dbRows.length < min) {
    console.warn(
      `[CANDLE ERROR] insufficient data symbol=${sym} db_bars=${dbRows.length} ` +
      `min=${min} — trying Kite → IndianAPI`,
    );
  }

  // 2) Kite → IndianAPI upstream for backfill
  const up = await fetchUpstreamDailyCandles(sym);
  if (up.ok && up.candles.length > 0) {
    await upsertToDb(sym, up.candles);
    const src: CandleSource = up.provider === 'kite' ? 'kite' : 'indianapi';
    console.log(
      `[CANDLE FALLBACK SOURCE] ${src} symbol=${sym} bars=${up.candles.length} ` +
      `latency_ms=${Date.now() - t0}`,
    );
    return {
      candles: up.candles,
      source: src,
      hitUpstream: true,
      latencyMs: Date.now() - t0,
    };
  }
  const upErr = up.errorCode ?? 'unknown';
  console.warn(`[UPSTREAM FETCH FAIL] symbol=${sym} reason="${upErr}"`);

  // 3) NSE — opt-in fallback only
  if (isNseHistoricalFetchEnabled()) {
    const nse = await fetchNseHistoricalCandles(sym);
    if (nse.ok && nse.candles.length > 0) {
      await upsertToDb(sym, nse.candles);
      _nseUsed++;
      console.log(`[CANDLE SOURCE] symbol=${sym} source=nse bars=${nse.candles.length}`);
      console.log(
        `[CANDLE FALLBACK SOURCE] nse symbol=${sym} bars=${nse.candles.length} ` +
        `latency_ms=${Date.now() - t0}`,
      );
      return {
        candles: nse.candles,
        source: 'nse',
        hitUpstream: true,
        latencyMs: Date.now() - t0,
      };
    }
    const nseErr = nse.errorCode ?? 'unknown';
    console.warn(`[NSE FETCH FAIL] symbol=${sym} reason="${nseErr}"`);
  } else {
    console.log(`[NSE FETCH SKIP] symbol=${sym} reason=NSE_HISTORICAL_FETCH_ENABLED!=true`);
  }

  // 4) DB thin
  if (dbRows.length > 0) {
    _dbUsed++;
    console.log(`[CANDLE SOURCE] symbol=${sym} source=db-thin bars=${dbRows.length}`);
    return {
      candles: dbRows,
      source: 'db-thin',
      hitUpstream: true,
      latencyMs: Date.now() - t0,
    };
  }

  _failed++;
  throw new Error(
    `CANDLE_NO_DATA symbol=${sym} upstream="${upErr}" ` +
    `nse_enabled=${isNseHistoricalFetchEnabled()} db_bars=0`,
  );
}
