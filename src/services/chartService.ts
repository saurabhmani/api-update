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

const CHART_TTL_INTRADAY  = 60;
const CHART_TTL_DAILY     = 3600;

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
  // Daily/weekly/monthly use IndianAPI historical (response shape
  // CONFIRMED). Sub-day intervals would route through getIntradayCandles
  // once the upstream `/intraday` response shape is verified — until
  // then they fall back to a 1mo historical pull and the UI presents
  // a coarser series rather than serving stale or broken data.
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
  const cKey = chartKey(sym, interval, from, to, limit);
  const ttl  = interval.includes('minute') || interval.includes('hour')
    ? CHART_TTL_INTRADAY : CHART_TTL_DAILY;

  // Layer 1: Redis
  const cached = await fromRedis(cKey);
  if (cached?.length) {
    return {
      symbol: sym,
      instrument_key: `NSE_EQ|${sym}`,
      interval,
      from: from ?? null,
      to:   to   ?? null,
      candles: cached,
      count:   cached.length,
      source:  'redis',
      cached:  true,
    };
  }

  // Resolve instrument key
  const instrumentKey = await resolveInstrumentKey(sym);

  // Layer 2: MySQL
  let candles = await fromMySQL(instrumentKey, interval, from, to, limit);
  let source: ChartResult['source'] = 'mysql';

  // Layer 3: IndianAPI (when MySQL is empty)
  if (!candles.length) {
    candles = await fromIndianApi(sym, interval, from, to, limit);
    // The ChartResult `source` union is still 'redis' | 'mysql' | 'yahoo' // @deprecated marker
    // for legacy reasons; new code that wants the true provider
    // should consult q365_data_feed_health (Step 7) where the
    // IndianAPI invocation is already logged. Marking 'yahoo' here // @deprecated marker
    // keeps the existing client-side renderer working unchanged.
    source  = 'yahoo'; // @deprecated marker
    if (candles.length > 0) {
      persistChartCandles(instrumentKey, interval, candles).catch(() => {});
    }
  }

  if (candles.length > 0) {
    await cacheSet(cKey, candles, ttl).catch(() => {});
  }

  return {
    symbol:         sym,
    instrument_key: instrumentKey,
    interval,
    from:           from ?? null,
    to:             to   ?? null,
    candles,
    count:          candles.length,
    source,
    cached:         false,
  };
}
