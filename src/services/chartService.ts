/**
 * Chart Service
 *
 * OHLCV candle data via 3-layer chain:
 *   Layer 1: Redis cache       key: chart:{symbol}:{interval}:{from}:{to}:{limit}
 *   Layer 2: MySQL candles     instrument_key + interval_unit + ts
 *   Layer 3: Yahoo Finance     public, no auth, 15-min delayed // @deprecated marker
 *
 * If MySQL has no candles for a symbol yet, Yahoo fills the gap // @deprecated marker
 * and the fetched candles are persisted to MySQL for next time.
 */

import { cacheGet, cacheSet }       from '@/lib/redis';
import { db }                        from '@/lib/db';
import { persistCandle }             from './marketDataService';
import { isMarketOpen, getMarketStatus } from '@/lib/marketData/marketHours';
import {
  fetchYahooPublicCandles,
  chartIntervalToYahoo,
} from '@/lib/marketData/yahooChartPublic';

// ── Types ─────────────────────────────────────────────────────────

export interface OhlcvBar {
  ts:     string;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
  oi:     number;
}

export type ChartInterval =
  | '1minute' | '5minute' | '15minute' | '30minute' | '60minute'
  | '1day' | '1week' | '1month';

export interface ChartResult {
  symbol:         string;
  instrument_key: string;
  interval:       ChartInterval;
  from:           string | null;
  to:             string | null;
  candles:        OhlcvBar[];
  count:          number;
  source:         'redis' | 'mysql' | 'yahoo'; // @deprecated marker
  cached:         boolean;
}

// ── Redis key ──────────────────────────────────────────────────────

const chartKey = (sym: string, interval: string, from?: string, to?: string, limit?: number) =>
  `chart:${sym}:${interval}:${from ?? 'x'}:${to ?? 'x'}:${limit ?? 0}`;

const CHART_TTL_INTRADAY_OPEN  = 15;
const CHART_TTL_INTRADAY       = 60;
const CHART_TTL_DAILY          = 3600;

const INTRADAY_BUCKET_MIN: Partial<Record<ChartInterval, number>> = {
  '1minute':  1,
  '5minute':  5,
  '15minute': 15,
  '30minute': 30,
  '60minute': 60,
};

const DAILY_STALE_MS = 3 * 24 * 60 * 60 * 1000;

function defaultFromForInterval(interval: ChartInterval): string | undefined {
  if (interval === '1day') {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 90);
    return d.toISOString().slice(0, 10);
  }
  if (interval === '1week') {
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() - 2);
    return d.toISOString().slice(0, 10);
  }
  if (INTRADAY_BUCKET_MIN[interval] != null) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 7);
    return d.toISOString().slice(0, 10);
  }
  return undefined;
}

function dayKey(ts: string): string {
  return String(ts).slice(0, 10);
}

function aggregateCandles(bars: OhlcvBar[], bucketMinutes: number): OhlcvBar[] {
  if (bucketMinutes <= 1 || bars.length === 0) return bars;
  const bucketMs = bucketMinutes * 60 * 1000;
  const buckets = new Map<number, OhlcvBar>();

  for (const bar of bars) {
    const t = new Date(bar.ts).getTime();
    if (!Number.isFinite(t)) continue;
    const key = Math.floor(t / bucketMs) * bucketMs;
    const existing = buckets.get(key);
    if (!existing) {
      buckets.set(key, {
        ts:     new Date(key).toISOString(),
        open:   bar.open,
        high:   bar.high,
        low:    bar.low,
        close:  bar.close,
        volume: bar.volume,
        oi:     bar.oi,
      });
      continue;
    }
    existing.high   = Math.max(existing.high, bar.high);
    existing.low    = Math.min(existing.low, bar.low);
    existing.close  = bar.close;
    existing.volume += bar.volume;
    existing.oi     = Math.max(existing.oi, bar.oi);
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([, bar]) => bar);
}

function mergeCandlesByDay(existing: OhlcvBar[], incoming: OhlcvBar[]): OhlcvBar[] {
  const byDay = new Map<string, OhlcvBar>();
  for (const bar of existing) byDay.set(dayKey(bar.ts), bar);
  for (const bar of incoming) byDay.set(dayKey(bar.ts), bar);
  return Array.from(byDay.values()).sort((a, b) => a.ts.localeCompare(b.ts));
}

function latestBarMs(bars: OhlcvBar[]): number {
  if (!bars.length) return 0;
  const t = new Date(bars[bars.length - 1].ts).getTime();
  return Number.isFinite(t) ? t : 0;
}

function istToday(): string {
  return getMarketStatus().nowIst.slice(0, 10);
}

function isDailySeriesStale(bars: OhlcvBar[]): boolean {
  const latest = latestBarMs(bars);
  if (!latest) return true;

  const latestDay = dayKey(bars[bars.length - 1].ts);
  const today = istToday();

  // Missing today's bar after the session has started → refresh.
  if (latestDay < today && isMarketOpen()) return true;

  // Missing yesterday+ when we're on a new trading day → refresh.
  if (latestDay < today) {
    const ageMs = Date.now() - latest;
    return ageMs > 20 * 60 * 60 * 1000;
  }

  return Date.now() - latest > DAILY_STALE_MS;
}

function isIntradaySeriesStale(bars: OhlcvBar[]): boolean {
  if (!bars.length) return true;
  if (!isMarketOpen()) return false;
  const latest = latestBarMs(bars);
  return Date.now() - latest > 5 * 60 * 1000;
}

async function fromYahooPublic(
  symbol: string,
  interval: ChartInterval,
  limit = 200,
): Promise<OhlcvBar[]> {
  const { yahoo, range } = chartIntervalToYahoo(interval);
  const bars = await fetchYahooPublicCandles(symbol, yahoo, range);
  return bars.slice(-limit).map(b => ({ ...b }));
}

// ── Layer 1: Redis ─────────────────────────────────────────────────

async function fromRedis(key: string): Promise<OhlcvBar[] | null> {
  try {
    return await cacheGet<OhlcvBar[]>(key);
  } catch { return null; }
}

// ── Layer 2: MySQL candles ─────────────────────────────────────────

async function resolveInstrumentKey(symbol: string): Promise<string> {
  try {
    const { rows } = await db.query(
      `SELECT instrument_key FROM instruments WHERE tradingsymbol=? AND is_active=TRUE LIMIT 1`,
      [symbol]
    );
    return (rows[0] as any)?.instrument_key ?? `NSE_EQ|${symbol}`;
  } catch {
    return `NSE_EQ|${symbol}`;
  }
}

async function fromMySQL(
  instrumentKey: string,
  interval:      string,
  from?:         string,
  to?:           string,
  limit          = 200
): Promise<OhlcvBar[]> {
  try {
    const params: (string | number)[] = [instrumentKey, interval];
    let   sql = `
      SELECT ts, open, high, low, close, volume, oi
      FROM candles
      WHERE instrument_key=? AND interval_unit=?
    `;
    if (from) { sql += ` AND ts >= ?`; params.push(from); }
    if (to)   { sql += ` AND ts <= ?`; params.push(to);   }
    sql += ` ORDER BY ts DESC LIMIT ?`;
    params.push(limit);

    const { rows } = await db.query(sql, params);
    return (rows as any[]).map(r => ({
      ts:     r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      open:   Number(r.open),
      high:   Number(r.high),
      low:    Number(r.low),
      close:  Number(r.close),
      volume: Number(r.volume),
      oi:     Number(r.oi),
    })).reverse();
  } catch {
    return [];
  }
}

// ── Layer 3: IndianAPI historical (Step 9 of cutover) ──────────────

import {
  getHistorical as indianHistorical,
} from '@/lib/marketData/providers/indianApiProvider';
import type { HistoricalRange } from '@/types/market';

const RANGE_FOR_INTERVAL: Record<ChartInterval, HistoricalRange> = {
  '1minute':  '1mo',
  '5minute':  '1mo',
  '15minute': '1mo',
  '30minute': '1mo',
  '60minute': '3mo',
  '1day':     '1y',
  '1week':    '5y',
  '1month':   '5y',
};

async function fromIndianApi(
  symbol:   string,
  interval: ChartInterval,
  _from?:   string,
  _to?:     string,
  limit     = 200,
): Promise<OhlcvBar[]> {
  // IndianAPI historical_data is daily-only. Never use it for sub-day
  // intervals — that produced empty 5m/15m charts or mis-labelled daily bars.
  if (INTRADAY_BUCKET_MIN[interval] != null && interval !== '1day') {
    return [];
  }

  const inv = await indianHistorical(symbol, RANGE_FOR_INTERVAL[interval]);
  if (inv.status === 'failed' || !inv.data) return [];
  const bars = inv.data.candles.map((c) => ({
    ts:     new Date(c.t).toISOString(),
    open:   c.o,
    high:   c.h,
    low:    c.l,
    close:  c.c,
    volume: c.v,
    oi:     0,
  }));
  return bars.slice(-limit);
}

async function fromMarketDataDaily(
  symbol: string,
  from?:  string,
  to?:    string,
  limit   = 200,
): Promise<OhlcvBar[]> {
  try {
    const params: (string | number)[] = [symbol];
    let sql = `
      SELECT ts, open, high, low, close, volume
      FROM market_data_daily
      WHERE symbol = ?
    `;
    if (from) { sql += ` AND ts >= ?`; params.push(from); }
    if (to)   { sql += ` AND ts <= ?`; params.push(to);   }
    sql += ` ORDER BY ts DESC LIMIT ?`;
    params.push(limit);

    const { rows } = await db.query(sql, params);
    return (rows as any[]).map(r => ({
      ts:     r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      open:   Number(r.open),
      high:   Number(r.high),
      low:    Number(r.low),
      close:  Number(r.close),
      volume: Number(r.volume),
      oi:     0,
    })).reverse();
  } catch {
    return [];
  }
}

async function persistChartCandles(
  instrumentKey: string,
  interval:      ChartInterval,
  bars:          OhlcvBar[]
): Promise<void> {
  const candleType  = interval === '1day' || interval === '1week' || interval === '1month'
    ? 'eod' : 'intraday';
  const intervalUnit = interval;

  for (const bar of bars) {
    await persistCandle(
      instrumentKey, candleType, intervalUnit,
      new Date(bar.ts), bar.open, bar.high, bar.low, bar.close, bar.volume, bar.oi
    ).catch(() => {});
  }
}

// ── Main API ───────────────────────────────────────────────────────

export async function getChartData(
  symbol:   string,
  interval: ChartInterval = '1day',
  from?:    string,
  to?:      string,
  limit     = 200
): Promise<ChartResult> {
  const sym  = symbol.toUpperCase();
  const bucketMin = INTRADAY_BUCKET_MIN[interval];
  const isIntraday = bucketMin != null && interval !== '1day';
  const effectiveFrom = from ?? defaultFromForInterval(interval);
  const effectiveLimit = interval === '1day'
    ? Math.min(limit, 120)
    : isIntraday
      ? Math.max(limit, 500)
      : limit;

  const cKey = chartKey(sym, interval, effectiveFrom, to, effectiveLimit);
  const marketOpen = isMarketOpen();
  const ttl  = isIntraday
    ? (marketOpen ? CHART_TTL_INTRADAY_OPEN : CHART_TTL_INTRADAY)
    : CHART_TTL_DAILY;

  // Layer 1: Redis — skip for open-market intraday (needs live refresh)
  const skipCache = isIntraday && marketOpen;
  if (!skipCache) {
    const cached = await fromRedis(cKey);
    if (cached?.length) {
      return {
        symbol: sym,
        instrument_key: `NSE_EQ|${sym}`,
        interval,
        from: effectiveFrom ?? null,
        to:   to   ?? null,
        candles: cached,
        count:   cached.length,
        source:  'redis',
        cached:  true,
      };
    }
  }

  const instrumentKey = await resolveInstrumentKey(sym);

  // Layer 2: MySQL (exact interval)
  let candles = await fromMySQL(instrumentKey, interval, effectiveFrom, to, effectiveLimit);
  let source: ChartResult['source'] = 'mysql';

  // Layer 2b: Intraday — aggregate from 1minute warehouse rows
  if (isIntraday && interval !== '1minute' && candles.length < 2) {
    const oneMinLimit = Math.min(effectiveLimit * (bucketMin ?? 1) * 3, 3000);
    const oneMin = await fromMySQL(instrumentKey, '1minute', effectiveFrom, to, oneMinLimit);
    if (oneMin.length > 0) {
      candles = aggregateCandles(oneMin, bucketMin!).slice(-effectiveLimit);
      source = 'mysql';
    }
  }

  // Layer 2c: Daily — scanner store fallback when candles table is thin
  if (interval === '1day' && candles.length < 5) {
    const daily = await fromMarketDataDaily(sym, effectiveFrom, to, effectiveLimit);
    if (daily.length > candles.length) {
      candles = daily;
      source = 'mysql';
    }
  }

  // Layer 3: Daily — refresh stale tail from IndianAPI + Yahoo, then merge
  if (interval === '1day') {
    if (candles.length === 0 || isDailySeriesStale(candles)) {
      const freshIndian = await fromIndianApi(sym, interval, effectiveFrom, to, effectiveLimit);
      const freshYahoo  = freshIndian.length < 5
        ? await fromYahooPublic(sym, interval, effectiveLimit)
        : [];
      const fresh = freshIndian.length > 0 ? freshIndian : freshYahoo;
      if (fresh.length > 0) {
        candles = candles.length > 0 ? mergeCandlesByDay(candles, fresh) : fresh;
        source = freshIndian.length > 0 ? 'mysql' : 'yahoo';
        persistChartCandles(instrumentKey, interval, fresh).catch(() => {});
      }
    }
  } else if (isIntraday) {
    // Layer 3b: Intraday — Yahoo public chart during market hours or when DB is thin
    const needsRefresh = candles.length < 10 || isIntradaySeriesStale(candles);
    if (needsRefresh) {
      const fresh = await fromYahooPublic(sym, interval, effectiveLimit);
      if (fresh.length > 0) {
        candles = fresh;
        source  = 'yahoo';
        if (marketOpen) {
          persistChartCandles(instrumentKey, interval, fresh.slice(-120)).catch(() => {});
        }
      }
    }
  } else if (!candles.length) {
    candles = await fromIndianApi(sym, interval, effectiveFrom, to, effectiveLimit);
    source  = 'yahoo';
    if (candles.length > 0) {
      persistChartCandles(instrumentKey, interval, candles).catch(() => {});
    }
  }

  candles = candles.slice(-effectiveLimit);

  if (candles.length > 0) {
    await cacheSet(cKey, candles, ttl).catch(() => {});
  }

  return {
    symbol:         sym,
    instrument_key: instrumentKey,
    interval,
    from:           effectiveFrom ?? null,
    to:             to   ?? null,
    candles,
    count:          candles.length,
    source,
    cached:         false,
  };
}
