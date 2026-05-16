/**
 * Market Data Service
 *
 * Source hierarchy:
 *   Layer 1: Redis cache                       (hot path, sub-millisecond)
 *   Layer 2: Kite + Yahoo live resolver        (primary live source, via marketQuote) // @deprecated marker
 *   Layer 3: MySQL candle warehouse            (historical fallback)
 *
 * Every MarketSnapshot carries a data_quality score (0–1):
 *   1.0  — fresh live quote
 *   0.75 — live quote from cache < 2 min old
 *   0.50 — MySQL candle (may be yesterday's close)
 *   0.25 — Yahoo Finance (delayed 15 min) // @deprecated marker
 *   0.10 — stale cache > 15 min
 *
 * The quality score flows into the signal engine's risk gate:
 *   quality < 0.40 → signal BLOCKED
 *
 * Also provides:
 *   - True 52-week high/low from live resolver (not intraday proxy)
 *   - Historical candles from MySQL
 *   - Scenario inputs: breadth ratio, sector trend, ATR
 */

import { db }                          from '@/lib/db';
import { cacheGet, cacheSet }          from '@/lib/redis';
import {
  fetchQuote,
  fetchOptionChain,
  type Quote,
}                                      from './marketQuote';

// Per-symbol cache/fetch logs ([CACHE] hit/miss/stale, [FETCH], [DB]
// upsert) used to fire on every getStockSnapshot call. With a 2,767-
// symbol scan touching this in tight loops, that's thousands of log
// lines per scan that nobody reads after the first 5 seconds. Gated
// behind LOG_VERBOSE_MARKETDATA=1 so they can be turned on while
// debugging without paying the synchronous-stdout cost in production.
// Failures still log via console.warn — those need to stay visible.
const VERBOSE_MD = process.env.LOG_VERBOSE_MARKETDATA === '1';

// ── Types ──────────────────────────────────────────────────────────

export interface MarketSnapshot {
  symbol:         string;
  instrument_key: string;
  ltp:            number;
  open:           number;
  high:           number;          // intraday high
  low:            number;          // intraday low
  close:          number;          // previous session close
  volume:         number;
  oi:             number;
  change_percent: number;
  change_abs:     number;
  vwap:           number | null;
  week52_high:    number;          // true 52W from live resolver — NOT intraday
  week52_low:     number;          // true 52W from live resolver — NOT intraday
  atr14:          number | null;   // 14-period ATR if candles available
  delivery_pct:   number | null;   // from live resolver priceInfo
  timestamp:      number;          // Unix ms
  source:         'live' | 'cache' | 'db' | 'yahoo'; // @deprecated marker
  data_quality:   number;          // 0–1 quality score
}

export interface OptionChainSnapshot {
  symbol:           string;
  underlying_value: number;
  expiry_dates:     string[];
  records:          Array<{
    strike_price:   number;
    expiry_date:    string;
    ce_oi:          number;
    ce_change_oi:   number;
    ce_iv:          number;
    ce_ltp:         number;
    ce_volume:      number;
    pe_oi:          number;
    pe_change_oi:   number;
    pe_iv:          number;
    pe_ltp:         number;
    pe_volume:      number;
  }>;
  timestamp: number;
  source:    'live' | 'synthetic' | 'yahoo' | 'unknown'; // @deprecated marker
}

// ── Redis keys ─────────────────────────────────────────────────────
const stockKey  = (s: string)  => `stock:${s.toUpperCase()}`;
const optionKey = (s: string)  => `options:${s.toUpperCase()}`;
// Raised from 60s → 300s. The scheduler writes snapshots every ~10min
// (500 symbols × 300ms batch delay). A 60s TTL meant snapshots expired
// before the next sweep completed, leaving Redis empty for the
// marketIntelligenceService → producing zero breadth/movers.
const STOCK_TTL   = 300;
const OPTIONS_TTL = 30;

// ── Freshness gate ────────────────────────────────────────────────
// Max age (ms) a cached quote may have before we refetch from the live resolver.
// In dev we go very aggressive so localhost behaves like a live feed;
// in prod we keep 60s to absorb bursty reads without hammering the resolver.
const FRESH_MAX_AGE_MS = process.env.NODE_ENV === 'development' ? 10_000 : 60_000;

// ── Helpers ────────────────────────────────────────────────────────

function n(v: unknown, fb = 0): number {
  const x = Number(v);
  return Number.isFinite(x) ? x : fb;
}

function qualityFromAge(ageMs: number): number {
  if (ageMs < 120_000)  return 0.75;   // < 2 min
  if (ageMs < 600_000)  return 0.60;   // < 10 min
  if (ageMs < 900_000)  return 0.40;   // < 15 min
  return 0.10;                          // stale
}

// ── Layer 2: Live resolver (Kite + Yahoo) ───────────────────────── // @deprecated marker

function normaliseQuote(q: Quote, instrumentKey = ''): MarketSnapshot {
  return {
    symbol:         q.symbol,
    instrument_key: instrumentKey || `NSE_EQ|${q.symbol}`,
    ltp:            n(q.lastPrice),
    open:           n(q.open),
    high:           n(q.dayHigh),
    low:            n(q.dayLow),
    close:          n(q.previousClose),
    volume:         n(q.totalTradedVolume),
    oi:             0,
    change_percent: n(q.pChange),
    change_abs:     n(q.change),
    vwap:           q.vwap != null ? n(q.vwap) : null,
    // TRUE 52W from live resolver weekHighLow — no longer using intraday high/low as proxy
    week52_high:    n(q.fiftyTwoWeekHigh),
    week52_low:     n(q.fiftyTwoWeekLow),
    atr14:          null,  // computed separately from candles
    delivery_pct:   q.deliveryToTradedQuantity != null
                      ? n(q.deliveryToTradedQuantity) : null,
    timestamp:      Date.now(),
    source:         'live',
    data_quality:   1.0,
  };
}

async function fetchFromResolver(
  symbol: string,
  instrumentKey: string
): Promise<MarketSnapshot | null> {
  try {
    const q = await fetchQuote(symbol);
    if (!q?.lastPrice) return null;
    return normaliseQuote(q, instrumentKey);
  } catch {
    return null;
  }
}

// ── Layer 3: MySQL candle warehouse ───────────────────────────────

export async function persistCandle(
  instrumentKey: string,
  candleType:    'intraday' | 'eod',
  intervalUnit:  string,
  ts:            Date,
  open:          number,
  high:          number,
  low:           number,
  close:         number,
  volume:        number,
  oi:            number = 0
): Promise<void> {
  await db.query(`
    INSERT INTO candles
      (instrument_key, candle_type, interval_unit, ts, open, high, low, close, volume, oi)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      open=VALUES(open), high=VALUES(high), low=VALUES(low),
      close=VALUES(close), volume=VALUES(volume), oi=VALUES(oi)
  `, [instrumentKey, candleType, intervalUnit, ts, open, high, low, close, volume, oi]);
}

export async function getLatestCandleFromDb(
  instrumentKey: string,
  intervalUnit  = '1day'
): Promise<MarketSnapshot | null> {
  try {
    const { rows } = await db.query(`
      SELECT instrument_key, open, high, low, close, volume, oi, ts
      FROM candles
      WHERE instrument_key=? AND interval_unit=?
      ORDER BY ts DESC LIMIT 1
    `, [instrumentKey, intervalUnit]);

    if (!rows.length) return null;
    const r   = rows[0] as any;
    const sym = instrumentKey.split('|')[1] ?? instrumentKey;

    return {
      symbol:         sym.toUpperCase(),
      instrument_key: instrumentKey,
      ltp:            n(r.close),
      open:           n(r.open),
      high:           n(r.high),
      low:            n(r.low),
      close:          n(r.close),
      volume:         n(r.volume),
      oi:             n(r.oi),
      change_percent: 0,
      change_abs:     0,
      vwap:           null,
      week52_high:    0,
      week52_low:     0,
      atr14:          null,
      delivery_pct:   null,
      timestamp:      new Date(r.ts).getTime(),
      source:         'db',
      data_quality:   0.50,
    };
  } catch {
    return null;
  }
}

// ── Layer 4: Yahoo Finance — REMOVED ─────────────────────────────── // @deprecated marker
//
// Yahoo Finance integration has been wiped from the system. The // @deprecated marker
// fetchFromYahoo + yahooFetch helpers below are kept as no-ops so // @deprecated marker
// the call sites in getMarketSnapshot (line ~480) compile, but they
// always return null — the chain falls through to whichever DB /
// cache layer remains.

async function yahooFetch(_url: string): Promise<any | null> { // @deprecated marker
  return null;
}

async function fetchFromYahoo(_symbol: string, _instrumentKey: string): Promise<MarketSnapshot | null> { // @deprecated marker
  return null;
}

// ── Yahoo historical daily bars ─────────────────────────────────── // @deprecated marker
//
// Fetches a parallel OHLCV series from Yahoo Finance so the signal // @deprecated marker
// engine has real date-by-date history to compute indicators on.
// Yahoo's /v8/finance/chart endpoint returns arrays of timestamps // @deprecated marker
// and OHLCV values; we map each index to a `candles` row and upsert
// via persistCandle so repeated calls are idempotent.
//
// Range grammar follows Yahoo's convention: '5d' | '1mo' | '3mo' | // @deprecated marker
// '6mo' | '1y' | '2y' | '5y' | '10y' | 'max'.

export interface DailyBar {
  ts:     Date;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

async function fetchYahooHistoricalDaily( // @deprecated marker
  _symbol: string,
  _range: '5d' | '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y' = '1y',
): Promise<DailyBar[]> {
  // Yahoo removed — no historical bars available from this layer. // @deprecated marker
  return [];
}

/**
 * Ensures a symbol has fresh daily history in the `candles` warehouse.
 *
 * Strategy:
 *   1. Look up the latest `candle_type='eod' AND interval_unit='1day'`
 *      row for this instrument.
 *   2. If none exists OR fewer than 100 rows total → do a deep
 *      backfill with range='2y' (~500 trading days).
 *   3. If the latest row is ≤ 3 days old → incremental top-up with
 *      range='5d' (cheap).
 *   4. Otherwise → range='1mo' (covers most scheduler downtime gaps).
 *
 * Each bar is upserted via persistCandle, so re-runs are idempotent.
 * Returns the number of bars upserted (for observability).
 */
export async function backfillDailyHistory(
  instrumentKey: string,
  symbol:        string,
): Promise<{ upserted: number; range: string; source: 'yahoo' | 'none' }> { // @deprecated marker
  const sym = symbol.toUpperCase();

  // How much history does the warehouse already have?
  let rowCount = 0;
  let latestTs: Date | null = null;
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS c, MAX(ts) AS latest
         FROM candles
        WHERE instrument_key = ?
          AND candle_type   = 'eod'
          AND interval_unit = '1day'`,
      [instrumentKey],
    );
    rowCount = Number((rows[0] as any)?.c ?? 0);
    const rawLatest = (rows[0] as any)?.latest;
    latestTs = rawLatest ? new Date(rawLatest) : null;
  } catch {
    // treat as empty — will trigger deep backfill
  }

  let range: '5d' | '1mo' | '2y';
  if (rowCount < 100 || !latestTs) {
    range = '2y';
  } else {
    const ageDays = (Date.now() - latestTs.getTime()) / 86_400_000;
    range = ageDays <= 3 ? '5d' : '1mo';
  }

  const bars = await fetchYahooHistoricalDaily(sym, range); // @deprecated marker
  if (bars.length === 0) {
    return { upserted: 0, range, source: 'none' };
  }

  // Upsert each bar. Fire in sequence — persistCandle is one round-trip
  // per row so we accept the small latency for transactional safety.
  let upserted = 0;
  for (const b of bars) {
    try {
      await persistCandle(
        instrumentKey,
        'eod',
        '1day',
        b.ts,
        b.open,
        b.high,
        b.low,
        b.close,
        b.volume,
        0,
      );
      upserted++;
    } catch {
      // Individual row failure — keep going so one bad bar doesn't
      // abort the whole backfill.
    }
  }

  return { upserted, range, source: 'yahoo' }; // @deprecated marker
}

// ── ATR computation from MySQL candles ────────────────────────────

export async function computeAtr14(instrumentKey: string): Promise<number | null> {
  try {
    const { rows } = await db.query(`
      SELECT high, low, close
      FROM candles
      WHERE instrument_key=? AND interval_unit='1day'
      ORDER BY ts DESC LIMIT 15
    `, [instrumentKey]);

    if (rows.length < 2) return null;

    const candles = (rows as any[]).reverse();
    const trs: number[] = [];

    for (let i = 1; i < candles.length; i++) {
      const h  = n(candles[i].high);
      const l  = n(candles[i].low);
      const pc = n(candles[i-1].close);
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }

    const atr = trs.slice(-14).reduce((a, b) => a + b, 0) / Math.min(14, trs.length);
    return parseFloat(atr.toFixed(2));
  } catch {
    return null;
  }
}

// ── Redis cache helpers ────────────────────────────────────────────

async function readFromCache(symbol: string): Promise<MarketSnapshot | null> {
  try {
    const snap = await cacheGet<MarketSnapshot>(stockKey(symbol));
    if (!snap) return null;
    const ageMs  = Date.now() - snap.timestamp;
    const quality = qualityFromAge(ageMs);
    return { ...snap, source: 'cache', data_quality: quality };
  } catch {
    return null;
  }
}

async function writeToCache(snap: MarketSnapshot): Promise<void> {
  try {
    await cacheSet(stockKey(snap.symbol), snap, STOCK_TTL);
  } catch {}
}

// ── Main public API ───────────────────────────────────────────────

/**
 * getMarketSnapshot
 *
 * Returns a MarketSnapshot using the layered hierarchy:
 *   Redis → live resolver (Kite+Yahoo) → MySQL → Yahoo // @deprecated marker
 *
 * Called by the background scheduler (not per user request).
 * Writes back to Redis on successful live fetch.
 */
export async function getMarketSnapshot(
  symbol:        string,
  instrumentKey: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<MarketSnapshot | null> {
  const sym = symbol.toUpperCase();
  const forceRefresh = opts.forceRefresh === true;

  // Layer 1: Redis — only if caller hasn't forced a refresh AND the
  // cached snapshot is within the freshness window. `qualityFromAge`
  // used to accept up to 15 minutes of age, which surfaced as stale
  // UI data during market hours. We now gate strictly on wall age.
  const cached = forceRefresh ? null : await readFromCache(sym);
  if (cached) {
    const ageMs = Date.now() - cached.timestamp;
    if (ageMs <= FRESH_MAX_AGE_MS) {
      if (VERBOSE_MD) console.log(`[CACHE] hit  ${sym}  age=${ageMs}ms  src=redis`);
      return cached;
    }
    if (VERBOSE_MD) console.log(`[CACHE] stale ${sym}  age=${ageMs}ms > ${FRESH_MAX_AGE_MS}ms — refetching`);
  } else if (!forceRefresh) {
    if (VERBOSE_MD) console.log(`[CACHE] miss  ${sym}`);
  } else {
    if (VERBOSE_MD) console.log(`[CACHE] bypass ${sym}  forceRefresh=true`);
  }

  // Layer 2: live resolver + Yahoo run in parallel // @deprecated marker
  const [liveSnap, yahooSnap] = await Promise.all([ // @deprecated marker
    fetchFromResolver(sym, instrumentKey),
    fetchFromYahoo(sym, instrumentKey), // @deprecated marker
  ]);

  // live resolver preferred; fall through to DB then Yahoo if resolver fails // @deprecated marker
  let snap = liveSnap;

  // Layer 3: MySQL candle (if live resolver is unavailable)
  if (!snap) {
    snap = await getLatestCandleFromDb(instrumentKey);
  }

  // Layer 4: use already-fetched Yahoo result as final fallback // @deprecated marker
  if (!snap && yahooSnap) { // @deprecated marker
    if (VERBOSE_MD) console.log(`[Yahoo] Using Yahoo as final fallback for ${sym}`); // @deprecated marker
    snap = yahooSnap; // @deprecated marker
  }

  if (!snap) {
    if (VERBOSE_MD) console.log(`[FETCH] ${sym} all layers failed — returning stale cache=${!!cached}`);
    return cached ?? null; // return stale cache if all layers fail
  }

  if (VERBOSE_MD) console.log(`[FETCH] ${sym}  src=${snap.source}  ltp=${snap.ltp}  vol=${snap.volume}  ts=${new Date(snap.timestamp).toISOString()}`);

  // Enrich with ATR if fresh
  if (snap.source === 'live' || snap.source === 'yahoo') { // @deprecated marker
    snap.atr14 = await computeAtr14(instrumentKey);
  }

  // Stamp the server clock onto the snapshot so downstream age math
  // is against the moment we actually observed the value, not a
  // vendor-provided timestamp that may trail reality.
  snap.timestamp = Date.now();

  // Write to Redis
  await writeToCache(snap);
  if (VERBOSE_MD) console.log(`[CACHE] write ${sym}  ttl=${STOCK_TTL}s`);

  // Persist to MySQL candles (non-blocking).
  // Failures still warn — those represent real persistence problems.
  if (snap.ltp > 0) {
    persistCandle(
      instrumentKey || `NSE_EQ|${sym}`,
      'intraday', '1minute',
      new Date(snap.timestamp),
      snap.open, snap.high, snap.low, snap.ltp,
      snap.volume, snap.oi
    ).then(() => { if (VERBOSE_MD) console.log(`[DB] upsert ${sym}  ltp=${snap.ltp}`); })
     .catch((e) => console.warn(`[DB] upsert ${sym} FAILED ${e?.message}`));
  }

  return snap;
}

// ── Batch snapshots ───────────────────────────────────────────────

export async function getBatchSnapshots(
  items: Array<{ symbol: string; instrument_key: string }>,
  opts: { forceRefresh?: boolean } = {},
): Promise<Record<string, MarketSnapshot>> {
  const results: Record<string, MarketSnapshot> = {};
  const BATCH = 5;

  for (let i = 0; i < items.length; i += BATCH) {
    const chunk = items.slice(i, i + BATCH);
    await Promise.all(chunk.map(async ({ symbol, instrument_key }) => {
      const snap = await getMarketSnapshot(symbol, instrument_key, opts);
      if (snap) results[symbol.toUpperCase()] = snap;
    }));
    if (i + BATCH < items.length) {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return results;
}

// ── Option chain ──────────────────────────────────────────────────

export async function getOptionChainSnapshot(
  symbol: string
): Promise<OptionChainSnapshot | null> {
  const sym = symbol.toUpperCase();

  const cached = await cacheGet<OptionChainSnapshot>(optionKey(sym));
  if (cached) return cached;

  try {
    const chain = await fetchOptionChain(sym);
    if (!chain) return null;

    const snap: OptionChainSnapshot = {
      symbol:           sym,
      underlying_value: chain.underlyingValue,
      expiry_dates:     chain.expiryDates,
      records:          chain.records.map(row => ({
        strike_price:  row.strikePrice,
        expiry_date:   row.expiryDate,
        ce_oi:         row.CE?.openInterest         ?? 0,
        ce_change_oi:  row.CE?.changeinOpenInterest ?? 0,
        ce_iv:         row.CE?.impliedVolatility    ?? 0,
        ce_ltp:        row.CE?.lastPrice            ?? 0,
        ce_volume:     row.CE?.totalTradedVolume    ?? 0,
        pe_oi:         row.PE?.openInterest         ?? 0,
        pe_change_oi:  row.PE?.changeinOpenInterest ?? 0,
        pe_iv:         row.PE?.impliedVolatility    ?? 0,
        pe_ltp:        row.PE?.lastPrice            ?? 0,
        pe_volume:     row.PE?.totalTradedVolume    ?? 0,
      })),
      timestamp: Date.now(),
      source:    (chain.source ?? 'live') as 'live' | 'synthetic' | 'yahoo' | 'unknown', // @deprecated marker
    };

    await cacheSet(optionKey(sym), snap, OPTIONS_TTL);
    return snap;
  } catch {
    return null;
  }
}

// ── Historical candles ────────────────────────────────────────────

export async function getHistoricalCandles(
  instrumentKey: string,
  intervalUnit   = '1day',
  limit          = 200
): Promise<Array<{
  ts: string; open: number; high: number;
  low: number; close: number; volume: number; oi: number;
}>> {
  try {
    const { rows } = await db.query(`
      SELECT ts, open, high, low, close, volume, oi
      FROM candles
      WHERE instrument_key=? AND interval_unit=?
      ORDER BY ts DESC LIMIT ?
    `, [instrumentKey, intervalUnit, limit]);

    return (rows as any[]).map(r => ({
      ts:     r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      open:   n(r.open),
      high:   n(r.high),
      low:    n(r.low),
      close:  n(r.close),
      volume: n(r.volume),
      oi:     n(r.oi),
    })).reverse();
  } catch {
    return [];
  }
}
