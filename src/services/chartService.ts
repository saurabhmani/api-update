/**
 * Chart Service
 *
 * OHLCV candle data via 3-layer chain:
 *   Layer 1: Redis cache       key: chart:{symbol}:{interval}:{from}:{to}:{limit}
 *   Layer 2: MySQL candles     instrument_key + interval_unit + ts
 *   Layer 3: Yahoo Finance     public, no auth, 15-min delayed
 *
 * If MySQL has no candles for a symbol yet, Yahoo fills the gap
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
  source:         'redis' | 'mysql' | 'yahoo';
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

// ── Layer 3: Yahoo Finance ─────────────────────────────────────────

const INTERVAL_MAP: Record<ChartInterval, string> = {
  '1minute':  '1m',
  '5minute':  '5m',
  '15minute': '15m',
  '30minute': '30m',
  '60minute': '60m',
  '1day':     '1d',
  '1week':    '1wk',
  '1month':   '1mo',
};

const RANGE_FOR_INTERVAL: Record<ChartInterval, string> = {
  '1minute':  '1d',
  '5minute':  '5d',
  '15minute': '5d',
  '30minute': '1mo',
  '60minute': '1mo',
  '1day':     '1y',
  '1week':    '2y',
  '1month':   '5y',
};

const YAHOO_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://finance.yahoo.com/',
  'Origin':          'https://finance.yahoo.com',
};

async function fromYahoo(
  symbol:   string,
  interval: ChartInterval,
  from?:    string,
  to?:      string,
  limit     = 200
): Promise<OhlcvBar[]> {
  const yahooSym  = symbol.endsWith('.NS') ? symbol : `${symbol}.NS`;
  const yInterval = INTERVAL_MAP[interval] ?? '1d';
  const range     = RANGE_FOR_INTERVAL[interval] ?? '1y';

  let baseUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSym)}`
              + `?interval=${yInterval}&range=${range}&includeAdjustedClose=false`;

  if (from) baseUrl += `&period1=${Math.floor(new Date(from).getTime() / 1000)}`;
  if (to)   baseUrl += `&period2=${Math.floor(new Date(to).getTime() / 1000)}`;

  // Try query1, fall back to query2
  const urls = [baseUrl, baseUrl.replace('query1.finance.yahoo.com', 'query2.finance.yahoo.com')];
  let result: any = null;

  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) continue;
      const json = await res.json();
      result = json?.chart?.result?.[0];
      if (result) break;
    } catch {
      // silent fallback to query2
    }
  }

  if (!result) return [];

  const timestamps = result.timestamp ?? [];
  const quote      = result.indicators?.quote?.[0] ?? {};
  const open   = quote.open   ?? [];
  const high   = quote.high   ?? [];
  const low    = quote.low    ?? [];
  const close  = quote.close  ?? [];
  const volume = quote.volume ?? [];

  const bars: OhlcvBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (close[i] == null) continue;
    bars.push({
      ts:     new Date(timestamps[i] * 1000).toISOString(),
      open:   parseFloat((open[i]   ?? close[i]).toFixed(2)),
      high:   parseFloat((high[i]   ?? close[i]).toFixed(2)),
      low:    parseFloat((low[i]    ?? close[i]).toFixed(2)),
      close:  parseFloat(Number(close[i]).toFixed(2)),
      volume: parseInt(volume[i] ?? '0') || 0,
      oi:     0,
    });
  }

  return bars.slice(-limit);
}

// ── Persist Yahoo candles to MySQL (async, non-blocking) ──────────

async function persistYahooCandles(
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

  // Layer 3: Yahoo Finance (if MySQL is empty)
  if (!candles.length) {
    candles = await fromYahoo(sym, interval, from, to, limit);
    source  = 'yahoo';
    // Persist to MySQL for next time (background, non-blocking)
    if (candles.length > 0) {
      persistYahooCandles(instrumentKey, interval, candles).catch(() => {});
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
