/**
 * Stock Detail Service
 *
 * Returns a complete stock detail payload for a given NSE symbol.
 * Read priority for every field:
 *
 *   LTP / Day High / Low / 52W data
 *     1. Redis  key: stock:{SYMBOL}         (MarketSnapshot, TTL 60s)
 *     2. Redis  key: nse:/quote-equity?symbol={SYMBOL}  (raw NSE cache)
 *     3. MySQL  candles — latest close + MAX/MIN over 365 days
 *
 *   Candles (OHLCV history)
 *     1. Redis  key: stock:candles:{SYMBOL}:{interval}  (TTL 120s)
 *     2. MySQL  candles table — keyed by instrument_key
 *
 *   Score (Quantorus365 ranking score)
 *     1. Redis  key: stock:{SYMBOL}         (snapshot has no score — skip)
 *     2. MySQL  rankings.score for tradingsymbol
 *
 *   Signal type + reasons
 *     1. Redis  key: signal:{instrument_key}  (full Signal object, TTL 300s)
 *     2. MySQL  signals JOIN signal_reasons   (most recent signal)
 *
 * IMPORTANT:
 *   - instrument_key is resolved once from instruments table and cached.
 *   - candles table is keyed by instrument_key, NOT tradingsymbol.
 *   - signal_reasons.reason_text — plain text per row, joined to signals.id
 *   - 52W high/low: from NSE quote cache if available, else MAX/MIN candles
 */

import { cacheGet, cacheSet } from '@/lib/redis';
import { db }                 from '@/lib/db';

// ── Output types ─────────────────────────────────────────────────

export interface CandleBar {
  ts:     string;   // ISO datetime
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
  oi:     number;
}

export interface SignalReason {
  rank:       number;
  factor_key: string | null;
  text:       string;
}

export interface StockDetail {
  symbol:         string;
  instrument_key: string;
  name:           string | null;

  // Price
  ltp:            number;
  open:           number;
  day_high:       number;
  day_low:        number;
  prev_close:     number;
  change_abs:     number;
  change_percent: number;
  volume:         number;
  vwap:           number | null;

  // 52-week
  week52_high:    number;
  week52_low:     number;

  // Candles
  candles:        CandleBar[];
  candle_interval:string;

  // Quantorus365 score
  score:          number | null;
  rank_position:  number | null;

  // Signal
  signal_type:    string | null;   // BUY | SELL | HOLD
  confidence:     number | null;
  signal_strength:string | null;   // Strong | Moderate | Weak
  entry_price:    number | null;
  stop_loss:      number | null;
  target1:        number | null;
  target2:        number | null;
  risk_reward:    number | null;
  reasons:        SignalReason[];
  signal_age_min: number | null;

  // Meta
  data_source:    'redis' | 'mysql' | 'mixed';
  as_of:          string;
}

// ── Helpers ───────────────────────────────────────────────────────

const n = (v: unknown, fb = 0): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : fb;
};

const STRENGTH_CONFIDENCE: Record<string, number> = {
  Strong: 85, Moderate: 65, Weak: 40,
};

const DETAIL_TTL    = 30;   // seconds — full detail cache
const CANDLE_TTL    = 120;  // seconds — candle array cache
const IKEY_TTL      = 3600; // seconds — instrument_key resolution cache
const DEFAULT_CANDLE_LIMIT = 100;

// ── Step 1: Resolve instrument_key from tradingsymbol ─────────────
// Candles are keyed by instrument_key, not tradingsymbol.
// Cache this resolution so we don't query instruments table per request.

async function resolveInstrumentKey(symbol: string): Promise<{
  instrument_key: string;
  name: string | null;
}> {
  const cacheKey = `ikey:${symbol}`;
  const cached   = await cacheGet<{ instrument_key: string; name: string | null }>(cacheKey);
  if (cached) return cached;

  try {
    const { rows } = await db.query(`
      SELECT instrument_key, name
      FROM instruments
      WHERE tradingsymbol = ?
        AND exchange      = 'NSE'
        AND is_active     = 1
      ORDER BY created_at DESC
      LIMIT 1
    `, [symbol]);

    if ((rows as any[]).length) {
      const row = (rows as any[])[0];
      const result = {
        instrument_key: String(row.instrument_key),
        name:           row.name ? String(row.name) : null,
      };
      await cacheSet(cacheKey, result, IKEY_TTL);
      return result;
    }
  } catch { /* instruments table may be empty */ }

  // Fallback: construct standard NSE equity key
  return { instrument_key: `NSE_EQ|${symbol}`, name: null };
}

// ── Step 2a: Price data — Redis stock:{SYMBOL} ────────────────────

interface PriceData {
  ltp:            number;
  open:           number;
  day_high:       number;
  day_low:        number;
  prev_close:     number;
  change_abs:     number;
  change_percent: number;
  volume:         number;
  vwap:           number | null;
  week52_high:    number;
  week52_low:     number;
  source:         'redis_snapshot' | 'redis_nse' | 'mysql';
}

async function getPriceFromRedis(symbol: string): Promise<PriceData | null> {

  // ── Try 1: MarketSnapshot (stock:{SYMBOL}) written by scheduler ──
  const snap = await cacheGet<any>(`stock:${symbol}`);
  if (snap && snap.ltp) {
    return {
      ltp:            n(snap.ltp),
      open:           n(snap.open),
      day_high:       n(snap.high),
      day_low:        n(snap.low),
      prev_close:     n(snap.close),
      change_abs:     n(snap.change_abs),
      change_percent: n(snap.change_percent),
      volume:         n(snap.volume),
      vwap:           snap.vwap != null ? n(snap.vwap) : null,
      // MarketSnapshot doesn't store 52W — will be filled from NSE cache or candles
      week52_high:    0,
      week52_low:     0,
      source:         'redis_snapshot',
    };
  }

  // ── Try 2: Raw NSE quote cache (nse:/quote-equity?symbol=...) ────
  const nseKey = `nse:/quote-equity?symbol=${encodeURIComponent(symbol)}`;
  const nseRaw = await cacheGet<any>(nseKey);
  if (nseRaw?.priceInfo) {
    const p = nseRaw.priceInfo;
    const t = nseRaw.marketDeptOrderBook?.tradeInfo ?? {};
    return {
      ltp:            n(p.lastPrice),
      open:           n(p.open),
      day_high:       n(p.intraDayHighLow?.max ?? p.lastPrice),
      day_low:        n(p.intraDayHighLow?.min ?? p.lastPrice),
      prev_close:     n(p.previousClose),
      change_abs:     n(p.change),
      change_percent: n(p.pChange),
      volume:         n(t.totalTradedVolume),
      vwap:           p.vwap != null ? n(p.vwap) : null,
      week52_high:    n(p.weekHighLow?.max),
      week52_low:     n(p.weekHighLow?.min),
      source:         'redis_nse',
    };
  }

  return null;
}

// ── Step 2b: Price data — MySQL fallback ──────────────────────────

async function getPriceFromMySQL(instrumentKey: string): Promise<PriceData | null> {
  try {
    // Latest candle for LTP/OHLCV
    const { rows: latest } = await db.query(`
      SELECT open, high, low, close, volume, oi, ts
      FROM candles
      WHERE instrument_key = ?
        AND candle_type    = 'intraday'
      ORDER BY ts DESC
      LIMIT 1
    `, [instrumentKey]);

    if (!(latest as any[]).length) return null;
    const row = (latest as any[])[0];

    // 52W high/low from EOD candles over past 365 days
    const { rows: annual } = await db.query(`
      SELECT MAX(high) AS week52_high,
             MIN(low)  AS week52_low
      FROM candles
      WHERE instrument_key = ?
        AND candle_type    = 'eod'
        AND ts             >= DATE_SUB(NOW(), INTERVAL 365 DAY)
    `, [instrumentKey]);

    const ann = (annual as any[])[0] ?? {};

    return {
      ltp:            n(row.close),
      open:           n(row.open),
      day_high:       n(row.high),
      day_low:        n(row.low),
      prev_close:     n(row.close),  // best proxy we have from candles
      change_abs:     0,
      change_percent: 0,
      volume:         n(row.volume),
      vwap:           null,
      week52_high:    n(ann.week52_high),
      week52_low:     n(ann.week52_low),
      source:         'mysql',
    };
  } catch {
    return null;
  }
}

// ── Step 3: Candles — Redis → MySQL ──────────────────────────────

async function getCandles(
  instrumentKey: string,
  symbol:        string,
  interval:      string,
  limit:         number
): Promise<CandleBar[]> {

  // ── Redis cache for candle array ─────────────────────────────
  const cKey   = `stock:candles:${symbol}:${interval}`;
  const cached = await cacheGet<CandleBar[]>(cKey);
  if (cached?.length) return cached;

  // ── MySQL ────────────────────────────────────────────────────
  // Candles are stored by instrument_key with candle_type + interval_unit
  const candleType   = interval === '1day' ? 'eod' : 'intraday';
  const intervalUnit = interval;

  try {
    const { rows } = await db.query(`
      SELECT ts, open, high, low, close, volume, oi
      FROM candles
      WHERE instrument_key = ?
        AND candle_type    = ?
        AND interval_unit  = ?
      ORDER BY ts DESC
      LIMIT ?
    `, [instrumentKey, candleType, intervalUnit, limit]);

    const bars: CandleBar[] = (rows as any[]).map(r => ({
      ts:     r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      open:   n(r.open),
      high:   n(r.high),
      low:    n(r.low),
      close:  n(r.close),
      volume: n(r.volume),
      oi:     n(r.oi),
    })).reverse(); // oldest-first for charting

    if (bars.length) {
      await cacheSet(cKey, bars, CANDLE_TTL);
    }
    return bars;
  } catch {
    return [];
  }
}

// ── Step 4: Score — MySQL rankings ───────────────────────────────

async function getScore(symbol: string): Promise<{
  score: number | null;
  rank_position: number | null;
}> {
  try {
    const { rows } = await db.query(`
      SELECT score, rank_position
      FROM rankings
      WHERE tradingsymbol = ?
      ORDER BY score DESC
      LIMIT 1
    `, [symbol]);

    if (!(rows as any[]).length) return { score: null, rank_position: null };
    const row = (rows as any[])[0];
    return {
      score:         n(row.score, 0),
      rank_position: row.rank_position != null ? n(row.rank_position) : null,
    };
  } catch {
    return { score: null, rank_position: null };
  }
}

// ── Step 5a: Signal — Redis signal:{instrument_key} ───────────────

interface SignalData {
  signal_type:    string | null;
  confidence:     number | null;
  signal_strength:string | null;
  entry_price:    number | null;
  stop_loss:      number | null;
  target1:        number | null;
  target2:        number | null;
  risk_reward:    number | null;
  reasons:        SignalReason[];
  signal_age_min: number | null;
  source:         'redis' | 'mysql';
}

async function getSignalFromRedis(instrumentKey: string): Promise<SignalData | null> {
  const cached = await cacheGet<any>(`signal:${instrumentKey}`);
  if (!cached) return null;

  // Full Signal object is stored in Redis by signalEngine.ts
  const reasons: SignalReason[] = (cached.reasons ?? []).map((r: any, i: number) => ({
    rank:       i + 1,
    factor_key: r.key   ?? null,
    text:       r.description ?? r.label ?? '',
  }));

  const genAt = cached.generated_at
    ? Math.round((Date.now() - new Date(cached.generated_at).getTime()) / 60000)
    : null;

  const strength = cached.confidence > 75 ? 'Strong'
                 : cached.confidence > 55 ? 'Moderate' : 'Weak';

  return {
    signal_type:    cached.direction ?? null,
    confidence:     typeof cached.confidence === 'number' ? cached.confidence : null,
    signal_strength:strength,
    entry_price:    cached.entry_price != null ? n(cached.entry_price) : null,
    stop_loss:      cached.stop_loss   != null ? n(cached.stop_loss)   : null,
    target1:        cached.target1     != null ? n(cached.target1)     : null,
    target2:        cached.target2     != null ? n(cached.target2)     : null,
    risk_reward:    cached.risk_reward != null ? n(cached.risk_reward) : null,
    reasons,
    signal_age_min: genAt,
    source:         'redis',
  };
}

// ── Step 5b: Signal — MySQL signals JOIN signal_reasons ───────────

async function getSignalFromMySQL(
  instrumentKey: string,
  symbol:        string
): Promise<SignalData | null> {
  try {
    // Get most recent signal
    const { rows: sigRows } = await db.query(`
      SELECT id, signal_type, strength, description, generated_at
      FROM signals
      WHERE instrument_key = ?
         OR tradingsymbol  = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `, [instrumentKey, symbol]);

    if (!(sigRows as any[]).length) return null;
    const sig = (sigRows as any[])[0];

    // Get reasons for this signal from signal_reasons table
    const { rows: reasonRows } = await db.query(`
      SELECT rank, reason_text, factor_key
      FROM signal_reasons
      WHERE signal_id = ?
      ORDER BY rank ASC
    `, [sig.id]);

    const reasons: SignalReason[] = (reasonRows as any[]).map(r => ({
      rank:       n(r.rank, 0),
      factor_key: r.factor_key ? String(r.factor_key) : null,
      text:       String(r.reason_text ?? ''),
    }));

    // If no rows in signal_reasons, fall back to parsing signals.description
    if (!reasons.length && sig.description) {
      sig.description.split(';').forEach((part: string, i: number) => {
        const clean = part.trim();
        if (clean) reasons.push({ rank: i + 1, factor_key: null, text: clean });
      });
    }

    const strength: string = sig.strength ?? 'Weak';
    const confidence        = STRENGTH_CONFIDENCE[strength] ?? 40;

    const genAt = sig.generated_at
      ? Math.round((Date.now() - new Date(sig.generated_at).getTime()) / 60000)
      : null;

    return {
      signal_type:    sig.signal_type ?? null,
      confidence,
      signal_strength:strength,
      entry_price:    null,
      stop_loss:      null,
      target1:        null,
      target2:        null,
      risk_reward:    null,
      reasons,
      signal_age_min: genAt,
      source:         'mysql',
    };
  } catch {
    return null;
  }
}

// ── Step 5: Signal — Redis first → MySQL fallback ────────────────

async function getSignal(
  instrumentKey: string,
  symbol:        string
): Promise<SignalData> {
  const fromRedis = await getSignalFromRedis(instrumentKey);
  if (fromRedis) return fromRedis;

  const fromMySQL = await getSignalFromMySQL(instrumentKey, symbol);
  if (fromMySQL) return fromMySQL;

  return {
    signal_type:    null,
    confidence:     null,
    signal_strength:null,
    entry_price:    null,
    stop_loss:      null,
    target1:        null,
    target2:        null,
    risk_reward:    null,
    reasons:        [],
    signal_age_min: null,
    source:         'mysql',
  };
}

// ── Public API ────────────────────────────────────────────────────

export async function getStockDetail(
  symbol:   string,
  interval: string = '1minute',
  candleLimit: number = DEFAULT_CANDLE_LIMIT
): Promise<StockDetail | null> {

  const sym = symbol.toUpperCase().trim();
  if (!sym) return null;

  // ── Full detail cache (avoids re-running all steps on repeated hits) ──
  const detailKey    = `stock:detail:${sym}:${interval}`;
  const cachedDetail = await cacheGet<StockDetail>(detailKey);
  if (cachedDetail) return cachedDetail;

  // ── Step 1: Resolve instrument_key ───────────────────────────────
  const { instrument_key, name } = await resolveInstrumentKey(sym);

  // ── Steps 2–5 run concurrently ───────────────────────────────────
  const [priceRedis, candleData, scoreData, signalData] = await Promise.all([
    getPriceFromRedis(sym),
    getCandles(instrument_key, sym, interval, Math.min(candleLimit, 500)),
    getScore(sym),
    getSignal(instrument_key, sym),
  ]);

  // ── Price resolution: Redis → MySQL ──────────────────────────────
  let price = priceRedis;
  let dataSource: StockDetail['data_source'] = 'redis';

  if (!price || price.ltp === 0) {
    price      = await getPriceFromMySQL(instrument_key);
    dataSource = 'mysql';
  } else if (price.source === 'redis_snapshot' && price.week52_high === 0) {
    // Snapshot has no 52W data — try NSE raw cache for 52W only
    const nseKey = `nse:/quote-equity?symbol=${encodeURIComponent(sym)}`;
    const nseRaw = await cacheGet<any>(nseKey);
    if (nseRaw?.priceInfo) {
      price.week52_high = n(nseRaw.priceInfo.weekHighLow?.max) || price.week52_high;
      price.week52_low  = n(nseRaw.priceInfo.weekHighLow?.min) || price.week52_low;
    }
    // Still 0 after Redis? Compute from MySQL candles
    if (price.week52_high === 0) {
      try {
        const { rows } = await db.query(`
          SELECT MAX(high) AS week52_high, MIN(low) AS week52_low
          FROM candles
          WHERE instrument_key = ?
            AND candle_type    = 'eod'
            AND ts             >= DATE_SUB(NOW(), INTERVAL 365 DAY)
        `, [instrument_key]);
        const a = (rows as any[])[0] ?? {};
        if (a.week52_high) { price.week52_high = n(a.week52_high); price.week52_low = n(a.week52_low); }
      } catch {}
    }
    dataSource = 'mixed';
  }

  if (!price) return null; // No data at all

  // Mix flag when some parts came from MySQL
  if (signalData.source === 'mysql' || scoreData.score === null) {
    dataSource = dataSource === 'mysql' ? 'mysql' : 'mixed';
  }

  // ── Assemble final result ─────────────────────────────────────────
  const result: StockDetail = {
    symbol:          sym,
    instrument_key,
    name,

    ltp:             price.ltp,
    open:            price.open,
    day_high:        price.day_high,
    day_low:         price.day_low,
    prev_close:      price.prev_close,
    change_abs:      price.change_abs,
    change_percent:  price.change_percent,
    volume:          price.volume,
    vwap:            price.vwap,

    week52_high:     price.week52_high,
    week52_low:      price.week52_low,

    candles:         candleData,
    candle_interval: interval,

    score:           scoreData.score,
    rank_position:   scoreData.rank_position,

    signal_type:     signalData.signal_type,
    confidence:      signalData.confidence,
    signal_strength: signalData.signal_strength,
    entry_price:     signalData.entry_price,
    stop_loss:       signalData.stop_loss,
    target1:         signalData.target1,
    target2:         signalData.target2,
    risk_reward:     signalData.risk_reward,
    reasons:         signalData.reasons,
    signal_age_min:  signalData.signal_age_min,

    data_source:     dataSource,
    as_of:           new Date().toISOString(),
  };

  // Cache the assembled result for DETAIL_TTL seconds
  await cacheSet(detailKey, result, DETAIL_TTL);

  return result;
}
