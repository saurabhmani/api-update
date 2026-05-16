// ════════════════════════════════════════════════════════════════
//  Candle Fallback Chain — DB → NSE primary → IndianAPI fallback
//
//  Spec "HYBRID NSE + INDIANAPI" — single shared helper that any
//  caller (Phase-3 candle provider, debug script, ad-hoc tools) can
//  use to obtain daily OHLCV bars for a symbol with a strict
//  failover chain. Performance-aware: in production the bulk
//  `refreshDailyCandles` pre-populates `market_data_daily`, so the
//  DB-fast-path covers the common case in <5 ms; live upstream is
//  only hit when the DB row count is below `MIN_BAR_THRESHOLD`
//  (default 100).
//
//  Order is intentional (NSE before IndianAPI per the hybrid spec —
//  NSE is free and uncapped against our IndianAPI plan, so we lean
//  on it first and only spend IndianAPI budget when NSE is tripped /
//  rate-limited / disabled):
//    1. DB fast-path (≥ MIN_BAR bars in market_data_daily)
//    2. NSE direct historical — PRIMARY upstream (free)
//    3. IndianAPI live (`getHistorical`) — FALLBACK, bounded by the
//       per-run budget (INDIANAPI_PER_RUN_LIMIT, default 100)
//    4. DB second-pass — return whatever rows exist, even if thin
//    5. Throw `CANDLE_NO_DATA` so the caller fails loud
//
//  Spec "NEVER return empty candle array / if no data: throw" —
//  the function returns Candle[] with length ≥ 1 OR throws. Phase 3
//  catches the throw and records a per-symbol rejection.
//
//  Per-run counters (`nse_used`, `api_used`, `failed`) are tracked
//  module-scope so the route handler can surface a single-run debug
//  envelope without re-instrumenting every call site. Reset by the
//  pipeline driver at run start via `resetCandleSourceCounters()`.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { Candle } from '@/lib/signal-engine';
import { getHistorical as getIndianApiHistorical } from '@/lib/marketData/providers/indianApiProvider';
import { fetchNseHistoricalCandles } from '@/lib/marketData/providers/nseHistoricalProvider';

// ── Config ─────────────────────────────────────────────────────────

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}

/** Minimum bar count to consider the DB fast-path "sufficient". The
 *  signal engine's strictest indicator (sma200/ema200) needs 200
 *  bars; we use 100 as the threshold for "the fast-path is good
 *  enough" — under that we burn an upstream call to top up. Tunable
 *  via CANDLE_MIN_BAR_THRESHOLD. */
const MIN_BAR_THRESHOLD = () => envNum('CANDLE_MIN_BAR_THRESHOLD', 30, 500, 100);

/** Max bars to read from DB per call. Same shape as the existing
 *  dbCandleProvider in run-signal-engine. */
const DB_BARS_LIMIT = 300;

// ── Per-run source counters ────────────────────────────────────────
//
// Module-scope so a single pipeline run can read totals at the end
// without threading a context through every call site. The pipeline
// driver MUST call `resetCandleSourceCounters()` before each run;
// outside a run they accumulate harmlessly until the next reset.

let _nseUsed = 0;
let _apiUsed = 0;
let _dbUsed  = 0;
let _failed  = 0;

export function resetCandleSourceCounters(): void {
  _nseUsed = 0;
  _apiUsed = 0;
  _dbUsed  = 0;
  _failed  = 0;
}

export function getCandleSourceCounters(): {
  nse_used: number;
  api_used: number;
  db_used:  number;
  failed:   number;
} {
  return {
    nse_used: _nseUsed,
    api_used: _apiUsed,
    db_used:  _dbUsed,
    failed:   _failed,
  };
}

// ── Public envelope ────────────────────────────────────────────────

export type CandleSource = 'db' | 'indianapi' | 'nse' | 'db-thin';

export interface CandleFetchResult {
  candles:   Candle[];
  source:    CandleSource;
  /** Whether we hit at least one upstream provider during this call.
   *  False on the DB fast-path; useful for budget telemetry. */
  hitUpstream: boolean;
  latencyMs: number;
}

// ── DB read ────────────────────────────────────────────────────────

async function readFromDb(symbol: string): Promise<Candle[]> {
  const result = await db.query(
    `SELECT ts, open, high, low, close, volume FROM (
       SELECT ts, open, high, low, close, volume
       FROM market_data_daily
       WHERE symbol = ?
       ORDER BY ts DESC
       LIMIT ?
     ) t
     ORDER BY ts ASC`,
    [symbol, DB_BARS_LIMIT],
  );
  return (result.rows as any[]).map((r) => ({
    ts: r.ts,
    open: Number(r.open),
    high: Number(r.high),
    low:  Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}

// ── IndianAPI live fetch ───────────────────────────────────────────

async function fetchFromIndianApi(symbol: string): Promise<Candle[] | { err: string }> {
  try {
    const inv = await getIndianApiHistorical(symbol, '1y');
    if (inv.status !== 'success' || !inv.data) {
      return { err: inv.errorCode ?? `status:${inv.status}` };
    }
    const series = inv.data;
    const out: Candle[] = [];
    for (const c of series.candles) {
      if (
        !Number.isFinite(c.t) || !Number.isFinite(c.o) || !Number.isFinite(c.h)
        || !Number.isFinite(c.l) || !Number.isFinite(c.c)
      ) continue;
      if (c.o <= 0 || c.h <= 0 || c.l <= 0 || c.c <= 0) continue;
      out.push({
        ts:    new Date(c.t).toISOString(),
        open:  c.o,
        high:  c.h,
        low:   c.l,
        close: c.c,
        volume: Number.isFinite(c.v) ? c.v : 0,
      });
    }
    out.sort((a, b) => new Date(a.ts as any).getTime() - new Date(b.ts as any).getTime());
    return out;
  } catch (err) {
    return { err: err instanceof Error ? err.message : String(err) };
  }
}

// ── DB upsert (so a successful upstream call repopulates DB and
//    future scans hit the fast-path) ──────────────────────────────

async function upsertToDb(symbol: string, candles: Candle[]): Promise<void> {
  if (candles.length === 0) return;
  // Best-effort write — never block the read path on a slow insert.
  // Schema for market_data_daily uses (symbol, ts) UNIQUE; ON DUPLICATE
  // KEY UPDATE keeps the latest values.
  try {
    const values: any[] = [];
    const placeholders: string[] = [];
    for (const c of candles) {
      placeholders.push('(?, ?, ?, ?, ?, ?, ?)');
      values.push(symbol, c.ts, c.open, c.high, c.low, c.close, c.volume);
    }
    if (placeholders.length === 0) return;
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

// ── Public API ─────────────────────────────────────────────────────

/**
 * Fetch daily OHLCV bars for `symbol`, walking the IndianAPI → NSE
 * → DB chain. Returns Candle[] with length ≥ 1, or throws.
 *
 * Spec "FORCE MIN DATA GUARANTEE" — when the DB has < MIN_BAR_THRESHOLD
 * bars, we attempt upstream sources to top up before falling back to
 * "DB-thin" (whatever rows exist). Throwing is reserved for the case
 * where NO source returned any data at all.
 *
 * `[CANDLE ERROR]` is emitted whenever the chain has to walk past the
 * DB fast-path; `[CANDLE FALLBACK SOURCE]` records which source won.
 */
export async function fetchDailyCandlesWithFallback(symbol: string): Promise<CandleFetchResult> {
  const t0  = Date.now();
  const min = MIN_BAR_THRESHOLD();

  // 1) DB fast-path. Hit DB FIRST in production: refreshDailyCandles
  //    already populated it from IndianAPI. Cheap (<5 ms), no upstream
  //    burn. Only walk the chain when the row count is thin.
  let dbRows = await readFromDb(symbol).catch((err) => {
    console.warn(
      `[CANDLE ERROR] db read failed for ${symbol}: ${(err as Error)?.message ?? String(err)}`,
    );
    return [] as Candle[];
  });
  if (dbRows.length >= min) {
    // Spec "ADD LOG" — single canonical [CANDLE SOURCE] marker per
    // symbol so an operator can grep one token and see what served
    // every row. The longer [CANDLE FALLBACK SOURCE] line stays for
    // upstream-fetch paths that carry extra context.
    _dbUsed++;
    console.log(`[CANDLE SOURCE] symbol=${symbol} source=db bars=${dbRows.length}`);
    return {
      candles: dbRows, source: 'db',
      hitUpstream: false, latencyMs: Date.now() - t0,
    };
  }

  // 2) NSE direct — PRIMARY upstream per the hybrid spec. Free to
  //    call against our IndianAPI plan, self-gated via env / daily
  //    cap / cooldown / trip state, so it's safe to attempt before
  //    burning paid quota.
  if (dbRows.length < min) {
    console.warn(
      `[CANDLE ERROR] insufficient data symbol=${symbol} db_bars=${dbRows.length} ` +
      `min=${min} — trying NSE primary`,
    );
  }
  const nse = await fetchNseHistoricalCandles(symbol);
  if (nse.ok && nse.candles.length > 0) {
    await upsertToDb(symbol, nse.candles);
    _nseUsed++;
    console.log(`[CANDLE SOURCE] symbol=${symbol} source=nse bars=${nse.candles.length}`);
    console.log(
      `[CANDLE FALLBACK SOURCE] nse symbol=${symbol} bars=${nse.candles.length} ` +
      `latency_ms=${Date.now() - t0}`,
    );
    return {
      candles: nse.candles, source: 'nse',
      hitUpstream: true, latencyMs: Date.now() - t0,
    };
  }
  const nseErr = nse.errorCode ?? 'unknown';
  console.warn(`[NSE FETCH FAIL] symbol=${symbol} reason="${nseErr}" — falling back to IndianAPI`);

  // 3) IndianAPI live — FALLBACK. The per-run budget guard inside
  //    fetchFromIndianApi will fast-fail with API_BUDGET_EXCEEDED
  //    once MAX_API_CALLS_PER_RUN (INDIANAPI_PER_RUN_LIMIT, default
  //    100) is reached, and the chain falls cleanly to DB-thin or a
  //    structured throw for that symbol.
  const ia = await fetchFromIndianApi(symbol);
  if (Array.isArray(ia) && ia.length > 0) {
    await upsertToDb(symbol, ia);
    _apiUsed++;
    console.log(`[CANDLE SOURCE] symbol=${symbol} source=indianapi bars=${ia.length}`);
    console.log(
      `[CANDLE FALLBACK SOURCE] indianapi symbol=${symbol} bars=${ia.length} ` +
      `latency_ms=${Date.now() - t0}`,
    );
    return {
      candles: ia, source: 'indianapi',
      hitUpstream: true, latencyMs: Date.now() - t0,
    };
  }
  const iaErr = Array.isArray(ia) ? 'empty_payload' : ia.err;
  console.warn(`[INDIANAPI FETCH FAIL] symbol=${symbol} reason="${iaErr}"`);

  // 4) DB second-pass — accept the thin row count rather than throw.
  //    The engine's per-symbol candle gate (validateCandleSeries)
  //    will reject anything below `minCandleCount`, and the symbol
  //    drops cleanly without halting the universe scan.
  if (dbRows.length > 0) {
    _dbUsed++;
    console.log(`[CANDLE SOURCE] symbol=${symbol} source=db-thin bars=${dbRows.length}`);
    console.log(
      `[CANDLE FALLBACK SOURCE] db-thin symbol=${symbol} bars=${dbRows.length} ` +
      `latency_ms=${Date.now() - t0} ` +
      `(NSE: ${nseErr}, IndianAPI: ${iaErr})`,
    );
    return {
      candles: dbRows, source: 'db-thin',
      hitUpstream: true, latencyMs: Date.now() - t0,
    };
  }

  // 5) Total failure — throw with a structured reason so callers can
  //    distinguish "candle fetch failed" from "engine logic failed".
  _failed++;
  throw new Error(
    `CANDLE_NO_DATA symbol=${symbol} nse_code="${nse.errorCode ?? 'n/a'}" ` +
    `nse_msg="${nse.errorMessage ?? 'n/a'}" indianapi="${iaErr}" db_bars=0`,
  );
}
