// ════════════════════════════════════════════════════════════════
//  Candle Fallback Chain — DB → IndianAPI → NSE (opt-in)
//
//  Provider priority for daily OHLCV:
//    1. DB cache (market_data_daily) — always first; during an active
//       pipeline scan (`isInFlight()`), evaluation reads are DB-only
//       so strategy evaluation never burns IndianAPI quota.
//    2. IndianAPI (`getHistorical`) — primary upstream for backfill /
//       incremental refresh (candle ingest path only).
//    3. NSE direct historical — fallback ONLY when
//       NSE_HISTORICAL_FETCH_ENABLED=true.
//    4. DB thin — return whatever rows exist.
//    5. Throw `CANDLE_NO_DATA`.
//
//  `refreshDailyCandles` → `getCandles` uses the IndianAPI ingest path.
//  Phase 3/4 `fetchDailyCandlesWithFallback` uses DB-only while a scan
//  is in flight.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { Candle } from '@/lib/signal-engine';
import { getHistorical as getIndianApiHistorical } from '@/lib/marketData/providers/indianApiProvider';
import {
  fetchNseHistoricalCandles,
  isNseHistoricalFetchEnabled,
} from '@/lib/marketData/providers/nseHistoricalProvider';
import { getIndianApiConfig } from '@/lib/marketData/providers/indianApiEndpoints';
import { isInFlight } from '@/lib/scanner/scannerState';

// ── Config ─────────────────────────────────────────────────────────

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}

/** Minimum bar count for the DB fast-path during strategy evaluation. */
const MIN_BAR_THRESHOLD = () => envNum('CANDLE_MIN_BAR_THRESHOLD', 30, 500, 100);

/** Bar depth above which ingest skips IndianAPI unless incremental refresh. */
export const SUFFICIENT_BAR_DEPTH = () =>
  envNum('CANDLE_SUFFICIENT_DEPTH', 30, 500, 100);

const DB_BARS_LIMIT = 300;

// ── Per-run source counters ────────────────────────────────────────

let _nseUsed = 0;
let _apiUsed = 0;
let _dbUsed  = 0;
let _failed  = 0;
let _indianApiRequestCount = 0;

export function resetCandleSourceCounters(): void {
  _nseUsed = 0;
  _apiUsed = 0;
  _dbUsed  = 0;
  _failed  = 0;
  _indianApiRequestCount = 0;
}

export function getCandleSourceCounters(): {
  nse_used: number;
  api_used: number;
  db_used: number;
  failed: number;
  indianapi_requests: number;
} {
  return {
    nse_used: _nseUsed,
    api_used: _apiUsed,
    db_used: _dbUsed,
    failed: _failed,
    indianapi_requests: _indianApiRequestCount,
  };
}

export function getIndianApiCandleRequestCount(): number {
  return _indianApiRequestCount;
}

// ── Public types ───────────────────────────────────────────────────

export type CandleSource = 'db' | 'indianapi' | 'nse' | 'db-thin';

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
  | 'BUDGET_THROTTLED';

export interface CandleFetchResult {
  candles: Candle[];
  source: CandleSource;
  hitUpstream: boolean;
  latencyMs: number;
}

export interface DailyCandleFetchOptions {
  /** When true, allow IndianAPI even if DB already has sufficient depth. */
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

function mapProviderErrorCode(
  errorCode: string | null | undefined,
  status?: number,
): IndianApiCandleErrorCode | string {
  const code = (errorCode ?? '').toUpperCase();
  if (code === 'API_KEY_MISSING' || code.includes('NOT_CONFIGURED')) return 'API_KEY_MISSING';
  if (code === 'HTTP_403' || code === 'HTTP_401' || code.includes('AUTH')) return 'API_KEY_INVALID';
  if (code === 'HTTP_429' || code.includes('RATE') || code.includes('429')) return 'RATE_LIMITED';
  if (code === 'BUDGET_EXHAUSTED' || code === 'API_BUDGET_EXCEEDED') return 'BUDGET_EXCEEDED';
  if (code === 'BUDGET_THROTTLED') return 'BUDGET_THROTTLED';
  if (code === 'MARKET_CLOSED') return 'MARKET_CLOSED';
  if (code === 'EMPTY_RESPONSE' || code === 'UPSTREAM_NULL') return 'EMPTY_RESPONSE';
  if (code === 'MALFORMED_RESPONSE') return 'MALFORMED_RESPONSE';
  if (status != null && status >= 500 && status < 600) return 'UPSTREAM_5XX';
  if (code.startsWith('HTTP_5')) return 'UPSTREAM_5XX';
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
 * Fetch daily bars from IndianAPI for ingest/backfill. Never used from
 * strategy evaluation — callers must gate on `isInFlight()` / `dbOnly`.
 */
export async function fetchIndianApiDailyCandles(
  symbol: string,
  range: '1y' = '1y',
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
    };
  }
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

  let dbRows = await readDailyCandlesFromDb(sym).catch((err) => {
    console.warn(
      `[CANDLE ERROR] db read failed for ${sym}: ${(err as Error)?.message ?? String(err)}`,
    );
    return [] as Candle[];
  });

  const dbOnly = shouldUseDbOnly({ ...opts, evaluationRead: true });

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
      `min=${min} — trying IndianAPI primary`,
    );
  }

  // 2) IndianAPI — primary upstream for backfill
  const ia = await fetchIndianApiDailyCandles(sym);
  if (ia.ok && ia.candles.length > 0) {
    await upsertToDb(sym, ia.candles);
    console.log(
      `[CANDLE FALLBACK SOURCE] indianapi symbol=${sym} bars=${ia.candles.length} ` +
      `latency_ms=${Date.now() - t0}`,
    );
    return {
      candles: ia.candles,
      source: 'indianapi',
      hitUpstream: true,
      latencyMs: Date.now() - t0,
    };
  }
  const iaErr = ia.errorCode ?? 'unknown';
  console.warn(`[INDIANAPI FETCH FAIL] symbol=${sym} reason="${iaErr}"`);

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
    `CANDLE_NO_DATA symbol=${sym} indianapi="${iaErr}" ` +
    `nse_enabled=${isNseHistoricalFetchEnabled()} db_bars=0`,
  );
}
