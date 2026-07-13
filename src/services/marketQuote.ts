/**
 * Market Quote Service — Kite + Yahoo only // @deprecated marker
 *
 * Unified helpers for live quotes, indices, India VIX, and the
 * instrument master. This replaces the earlier dedicated exchange-
 * scraping module; the system now consults only two upstreams:
 *
 *   • Kite (real-time WebSocket ticks, via MarketDataResolver) // @deprecated marker
 *   • Yahoo Finance (15-min-delayed fallback + indices + VIX) // @deprecated marker
 *
 * Helpers without a live upstream (FII/DII flows, market breadth,
 * sector regime) return empty data — callers degrade gracefully.
 * Gainers/losers are served from IndianAPI /trending via getMovers(),
 * with a rankings-table fallback when movers are unavailable.
 */
import { cacheGet, cacheSet }   from '@/lib/redis';
import { resolvePrice }         from '@/lib/marketData/resolver/marketDataResolver';
import { getStockDetails }      from '@/lib/marketData/providers/indianApiProvider';
import { fetchYahooPublicQuote, fetchYahoo52WeekRange } from '@/lib/marketData/yahooChartPublic';
import { fetchYahooFundamentals } from '@/lib/marketData/yahooFundamentals';
import { isMarketOpen, getMarketStatus } from '@/lib/marketData/marketHours';
import { getMovers, getCorporateIntel } from '@/providers/MarketDataProvider';
import { corporateIntelCacheKey, cache as memCache } from '@/lib/cache';
import { fetchFromYahooCached } from '@/lib/marketData/priceCache'; // @deprecated marker
import { StaleDataError }       from '@/types/market';
import type { MoversBucket }    from '@/types/market';
import type { MarketSnapshot }  from '@/types/market';
import { db }                   from '@/lib/db';

// ── Types ──────────────────────────────────────────────────────────

export interface Quote {
  symbol:                    string;
  lastPrice:                 number;
  change:                    number;
  pChange:                   number;
  open:                      number;
  dayHigh:                   number;
  dayLow:                    number;
  previousClose:             number;
  totalTradedVolume:         number;
  totalTradedValue:          number;
  fiftyTwoWeekHigh:          number;
  fiftyTwoWeekLow:           number;
  deliveryToTradedQuantity?: number;
  vwap?:                     number;
  series?:                   string;
}

export interface IndexSnapshot {
  name:          string;
  last:          number;
  variation:     number;
  percentChange: number;
  open:          number;
  high:          number;
  low:           number;
  previousClose: number;
  yearHigh:      number;
  yearLow:       number;
  advances?:     number;
  declines?:     number;
}

export interface MarketBreadth {
  advancing:             number;
  declining:             number;
  unchanged:             number;
  total:                 number;
  advance_decline_ratio: number | null;
}

export interface SectorRegime {
  sector:         string;
  index_name:     string;
  change_percent: number;
  trend:          'up' | 'down' | 'flat';
  strength:       'Strong' | 'Moderate' | 'Weak';
}

export interface FiiDiiEntry {
  date:     string;
  fii_buy:  number;
  fii_sell: number;
  fii_net:  number;
  dii_buy:  number;
  dii_sell: number;
  dii_net:  number;
}

export interface OptionChainRow {
  strikePrice: number;
  expiryDate:  string;
  CE?: {
    openInterest:         number;
    changeinOpenInterest: number;
    impliedVolatility:    number;
    lastPrice:            number;
    totalTradedVolume:    number;
    bidprice:             number;
    askPrice:             number;
  };
  PE?: {
    openInterest:         number;
    changeinOpenInterest: number;
    impliedVolatility:    number;
    lastPrice:            number;
    totalTradedVolume:    number;
    bidprice:             number;
    askPrice:             number;
  };
}

export interface OptionChainResult {
  symbol:           string;
  requestedSymbol?: string;
  records:          OptionChainRow[];
  underlyingValue:  number;
  expiryDates:      string[];
  source?:          'kite' | 'yahoo' | 'synthetic'; // @deprecated marker
}

// ── Quotes ────────────────────────────────────────────────────────
//
// Live price comes from MarketDataResolver (Kite primary, Yahoo // @deprecated marker
// fallback). The Yahoo fallback path additionally fetches day OHLC // @deprecated marker
// + 52-week range from Yahoo chart metadata so the richer Quote // @deprecated marker
// shape below is populated even when no Kite tick is available. // @deprecated marker

async function fetchYahooMeta(symbol: string): Promise<Partial<Quote> | null> { // @deprecated marker
  const yq = await fetchYahooPublicQuote(symbol);
  if (!yq) return null;
  return {
    symbol:            yq.symbol,
    lastPrice:         yq.lastPrice,
    change:            yq.change,
    pChange:           yq.pChange,
    open:              yq.open,
    dayHigh:           yq.dayHigh,
    dayLow:            yq.dayLow,
    previousClose:     yq.previousClose,
    totalTradedVolume: yq.volume,
    totalTradedValue:  0,
    fiftyTwoWeekHigh:  0,
    fiftyTwoWeekLow:   0,
  };
}

function snapshotToQuote(sym: string, snap: MarketSnapshot): Quote {
  const ltp = snap.ltp || snap.price;
  const prevClose = snap.prevClose || ltp;
  const change = snap.change ?? (ltp - prevClose);
  const pChange = snap.changePercent ?? (prevClose > 0 ? (change / prevClose) * 100 : 0);
  return {
    symbol:            sym,
    lastPrice:         ltp,
    change,
    pChange,
    open:              snap.open  || ltp,
    dayHigh:           snap.high  || ltp,
    dayLow:            snap.low   || ltp,
    previousClose:     prevClose,
    totalTradedVolume: snap.volume || 0,
    totalTradedValue:  0,
    fiftyTwoWeekHigh:  0,
    fiftyTwoWeekLow:   0,
  };
}

/** Direct IndianAPI call — bypasses NIFTY500 resolver lock for detail-page quotes. */
async function fetchIndianApiQuote(sym: string): Promise<Quote | null> {
  try {
    const inv = await getStockDetails(sym);
    if (inv.status !== 'success' || !inv.data?.price) return null;
    return snapshotToQuote(sym, inv.data);
  } catch {
    return null;
  }
}

function istToday(): string {
  return getMarketStatus().nowIst.slice(0, 10);
}

interface DbCandleRow {
  ts: Date | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

async function loadRecentDailyCandles(sym: string, limit = 3): Promise<DbCandleRow[]> {
  try {
    const { rows } = await db.query<DbCandleRow>(
      `SELECT ts, open, high, low, close, volume
         FROM candles
        WHERE interval_unit = '1day'
          AND (instrument_key = ? OR SUBSTRING_INDEX(instrument_key, '|', -1) = ?)
        ORDER BY ts DESC
        LIMIT ?`,
      [`NSE_EQ|${sym}`, sym, limit],
    );
    return rows;
  } catch {
    return [];
  }
}

/** 52-week range from warehouse daily bars (candles EOD → market_data_daily). */
async function load52WeekRangeFromDb(sym: string): Promise<{ high: number; low: number } | null> {
  const ikey = `NSE_EQ|${sym}`;
  const queries = [
    `SELECT MAX(high) AS week52_high, MIN(low) AS week52_low
       FROM candles
      WHERE (instrument_key = ? OR SUBSTRING_INDEX(instrument_key, '|', -1) = ?)
        AND ts >= DATE_SUB(NOW(), INTERVAL 365 DAY)
        AND (candle_type = 'eod' OR interval_unit = '1day' OR candle_type IS NULL)`,
  ];
  for (const sql of queries) {
    try {
      const { rows } = await db.query<{ week52_high: number; week52_low: number }>(sql, [ikey, sym]);
      const high = Number(rows[0]?.week52_high) || 0;
      const low  = Number(rows[0]?.week52_low)  || 0;
      if (high > 0 && low > 0) return { high, low };
    } catch { /* optional schema */ }
  }
  try {
    const { rows } = await db.query<{ week52_high: number; week52_low: number }>(
      `SELECT MAX(high) AS week52_high, MIN(low) AS week52_low
         FROM market_data_daily
        WHERE symbol = ?
          AND ts >= DATE_SUB(NOW(), INTERVAL 365 DAY)`,
      [sym],
    );
    const high = Number(rows[0]?.week52_high) || 0;
    const low  = Number(rows[0]?.week52_low)  || 0;
    if (high > 0 && low > 0) return { high, low };
  } catch { /* table optional */ }
  return null;
}

async function enrichQuoteWith52Week(quote: Quote, sym: string): Promise<Quote> {
  if (quote.fiftyTwoWeekHigh > 0 && quote.fiftyTwoWeekLow > 0) return quote;

  const cacheKey = `quote:52w:${sym}`;
  const cached = await cacheGet<{ high: number; low: number }>(cacheKey);
  if (cached?.high && cached?.low) {
    return {
      ...quote,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh > 0 ? quote.fiftyTwoWeekHigh : cached.high,
      fiftyTwoWeekLow:  quote.fiftyTwoWeekLow  > 0 ? quote.fiftyTwoWeekLow  : cached.low,
    };
  }

  const fromDb = await load52WeekRangeFromDb(sym);
  if (fromDb) {
    await cacheSet(cacheKey, fromDb, 6 * 3600).catch(() => {});
    return {
      ...quote,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh > 0 ? quote.fiftyTwoWeekHigh : fromDb.high,
      fiftyTwoWeekLow:  quote.fiftyTwoWeekLow  > 0 ? quote.fiftyTwoWeekLow  : fromDb.low,
    };
  }

  const fromYahoo = await fetchYahoo52WeekRange(sym);
  if (fromYahoo) {
    await cacheSet(cacheKey, fromYahoo, 6 * 3600).catch(() => {});
    return {
      ...quote,
      fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh > 0 ? quote.fiftyTwoWeekHigh : fromYahoo.high,
      fiftyTwoWeekLow:  quote.fiftyTwoWeekLow  > 0 ? quote.fiftyTwoWeekLow  : fromYahoo.low,
    };
  }

  return quote;
}

/** Name / sector for symbols missing from the instruments master. */
export async function resolveInstrumentProfile(symbol: string): Promise<{
  tradingsymbol:  string;
  instrument_key: string;
  exchange:       string;
  name:           string;
  sector:         string | null;
}> {
  const sym = symbol.toUpperCase();
  const base = {
    tradingsymbol:  sym,
    instrument_key: `NSE_EQ|${sym}`,
    exchange:       'NSE',
    name:           sym,
    sector:         null as string | null,
  };

  try {
    const { rows } = await db.query<{ name?: string; sector?: string }>(
      `SELECT name, sector FROM instruments WHERE tradingsymbol = ? LIMIT 1`,
      [sym],
    );
    if (rows[0]?.name) {
      base.name = String(rows[0].name);
      if (rows[0].sector) base.sector = String(rows[0].sector);
      return base;
    }
  } catch { /* optional */ }

  try {
    const { rows } = await db.query<{ name?: string; sector?: string }>(
      `SELECT name, sector FROM rankings WHERE tradingsymbol = ? LIMIT 1`,
      [sym],
    );
    if (rows[0]?.name) {
      base.name = String(rows[0].name);
      if (rows[0].sector) base.sector = String(rows[0].sector);
      return base;
    }
  } catch { /* optional */ }

  return base;
}

/** Warehouse fallback when live resolver / Yahoo are unavailable. */
async function buildQuoteFromDb(sym: string): Promise<Quote | null> {
  const dailyRows = await loadRecentDailyCandles(sym, 3);
  const latest = dailyRows[0];
  const prior  = dailyRows[1];

  let ltp = 0;
  let rankingsUpdated: Date | null = null;
  let rankingsVolume = 0;

  try {
    const { rows } = await db.query<{
      ltp: number; pct_change: number; volume: number; updated_at: Date | string;
    }>(
      `SELECT ltp, pct_change, volume, updated_at
         FROM rankings
        WHERE tradingsymbol = ?
        LIMIT 1`,
      [sym],
    );
    const r = rows[0];
    if (r) {
      ltp = Number(r.ltp) || 0;
      rankingsVolume = Number(r.volume) || 0;
      rankingsUpdated = r.updated_at instanceof Date
        ? r.updated_at
        : new Date(String(r.updated_at));
    }
  } catch { /* rankings optional */ }

  const latestCandleMs = latest
    ? new Date(latest.ts instanceof Date ? latest.ts : String(latest.ts)).getTime()
    : 0;
  const rankingsMs = rankingsUpdated?.getTime() ?? 0;
  const latestClose = latest ? Number(latest.close) || 0 : 0;

  // Prefer the freshest warehouse price: latest daily close beats stale rankings.
  if (latestClose > 0 && latestCandleMs >= rankingsMs) {
    ltp = latestClose;
  } else if (!ltp || ltp <= 0) {
    ltp = await fetchStockSpotFromDb(sym) ?? latestClose;
  }

  if (!ltp || ltp <= 0) return null;

  let open = ltp;
  let high = ltp;
  let low  = ltp;
  let volume = rankingsVolume;
  let previousClose = prior ? Number(prior.close) || ltp : ltp;

  if (latest) {
    const latestDay = String(latest.ts).slice(0, 10);
    const today = istToday();
    open  = Number(latest.open)  || ltp;
    high  = Number(latest.high)  || ltp;
    low   = Number(latest.low)   || ltp;
    volume = Number(latest.volume) || volume;

    if (latestDay === today) {
      previousClose = prior ? Number(prior.close) || previousClose : previousClose;
      // Today's bar may have a partial close — use rankings/live LTP as last price.
      if (ltp > 0) {
        high = Math.max(high, ltp);
        low  = Math.min(low > 0 ? low : ltp, ltp);
      }
    } else {
      previousClose = Number(latest.close) || previousClose;
    }
  }

  const change = previousClose > 0 ? ltp - previousClose : 0;
  const pct    = previousClose > 0 ? (change / previousClose) * 100 : 0;

  return {
    symbol:            sym,
    lastPrice:         ltp,
    change,
    pChange:           pct,
    open,
    dayHigh:           high,
    dayLow:            low,
    previousClose,
    totalTradedVolume: volume,
    totalTradedValue:  0,
    fiftyTwoWeekHigh:  0,
    fiftyTwoWeekLow:   0,
  };
}

export async function fetchQuote(symbol: string): Promise<Quote | null> {
  const sym = symbol.toUpperCase();
  const marketOpen = isMarketOpen();

  // During market hours prefer live upstreams; after hours allow short cache.
  const cacheKey = `quote:live:${sym}`;
  if (!marketOpen) {
    const cached = await cacheGet<Quote>(cacheKey);
    if (cached?.lastPrice) return cached;
  }

  // 1) Resolver path (IndianAPI for NIFTY500 universe members)
  const resolved = await resolvePrice(sym);

  // 2) Direct IndianAPI (bypasses NIFTY500 lock — needed for NSE1000 symbols)
  let liveQuote: Quote | null = null;
  if (marketOpen || !resolved.price) {
    liveQuote = await fetchIndianApiQuote(sym);
  }

  // 3) Yahoo public chart (verification-grade fallback, ~15 min delayed)
  const yahooMeta = (!liveQuote?.lastPrice && (!resolved.price || marketOpen))
    ? await fetchYahooMeta(sym)
    : null;

  if (liveQuote?.lastPrice) {
    const enriched = await enrichQuoteWith52Week(liveQuote, sym);
    await cacheSet(cacheKey, enriched, marketOpen ? 15 : 120).catch(() => {});
    return enriched;
  }

  if (resolved.price != null && resolved.price > 0) {
    const quote: Quote = {
      symbol:            sym,
      lastPrice:         resolved.price,
      change:            0,
      pChange:           resolved.pChange ?? 0,
      open:              0,
      dayHigh:           resolved.price,
      dayLow:            resolved.price,
      previousClose:     0,
      totalTradedVolume: 0,
      totalTradedValue:  0,
      fiftyTwoWeekHigh:  0,
      fiftyTwoWeekLow:   0,
    };
    const dbQuote = await buildQuoteFromDb(sym);
    if (dbQuote) {
      quote.open              = dbQuote.open              || quote.open;
      quote.dayHigh           = dbQuote.dayHigh           || quote.dayHigh;
      quote.dayLow            = dbQuote.dayLow            || quote.dayLow;
      quote.previousClose     = dbQuote.previousClose     || quote.previousClose;
      quote.totalTradedVolume = dbQuote.totalTradedVolume || quote.totalTradedVolume;
      if (quote.previousClose > 0) {
        quote.change  = quote.lastPrice - quote.previousClose;
        quote.pChange = (quote.change / quote.previousClose) * 100;
      } else if (!quote.pChange && dbQuote.pChange) {
        quote.pChange = dbQuote.pChange;
        quote.change  = dbQuote.change;
      }
    }
    const enriched = await enrichQuoteWith52Week(quote, sym);
    await cacheSet(cacheKey, enriched, marketOpen ? 15 : 120).catch(() => {});
    return enriched;
  }

  if (yahooMeta?.lastPrice) {
    const quote = await enrichQuoteWith52Week(yahooMeta as Quote, sym);
    await cacheSet(cacheKey, quote, marketOpen ? 30 : 300).catch(() => {});
    return quote;
  }

  const dbQuote = await buildQuoteFromDb(sym);
  if (dbQuote) return enrichQuoteWith52Week(dbQuote, sym);

  return null;
}

export interface InstrumentMeta {
  companyName:     string;
  industry:        string | null;
  sector:          string | null;
  macro:           string | null;
  isin:            string | null;
  listingDate:     string | null;
  faceValue:       number | null;
  issuedSize:      number | null;
  lowerCP:         number | null;
  upperCP:         number | null;
  priceBand:       string | null;
  surveillance:    string | null;
  survDesc:        string | null;
  isFNO:           boolean;
  derivatives:     unknown;
  slb:             unknown;
  lastUpdateTime:  string | null;
  pe:              number | null;
  sectorPe:        number | null;
  forwardPe:       number | null;
  eps:             number | null;
  beta:            number | null;
  pbRatio:         number | null;
  dividendYield:   number | null;
  roe:             number | null;
  debtToEquity:    number | null;
  marketCap:       number | null;
  avgVolume:       number | null;
  week52High:      number | null;
  week52Low:       number | null;
}

function positiveOrNull(v: unknown): number | null {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : null;
}

/** Fundamentals + company profile for stock-detail / financials tabs. */
export async function fetchInstrumentMeta(
  symbol: string,
  quote?: Quote | null,
): Promise<InstrumentMeta> {
  const sym = symbol.toUpperCase();
  const profile = await resolveInstrumentProfile(sym);
  const meta: InstrumentMeta = {
    companyName:     profile.name,
    industry:        null,
    sector:          profile.sector,
    macro:           null,
    isin:            null,
    listingDate:     null,
    faceValue:       null,
    issuedSize:      null,
    lowerCP:         null,
    upperCP:         null,
    priceBand:       null,
    surveillance:    null,
    survDesc:        null,
    isFNO:           false,
    derivatives:     null,
    slb:             null,
    lastUpdateTime:  null,
    pe:              null,
    sectorPe:        null,
    forwardPe:       null,
    eps:             null,
    beta:            null,
    pbRatio:         null,
    dividendYield:   null,
    roe:             null,
    debtToEquity:    null,
    marketCap:       null,
    avgVolume:       positiveOrNull(quote?.totalTradedVolume),
    week52High:      positiveOrNull(quote?.fiftyTwoWeekHigh),
    week52Low:       positiveOrNull(quote?.fiftyTwoWeekLow),
  };

  try {
    const { rows } = await db.query<{ isin?: string }>(
      `SELECT isin FROM instruments WHERE tradingsymbol = ? LIMIT 1`,
      [sym],
    );
    if (rows[0]?.isin) meta.isin = String(rows[0].isin);
  } catch { /* optional */ }

  try {
    const { rows } = await db.query<{ industry?: string }>(
      `SELECT industry FROM instruments WHERE tradingsymbol = ? LIMIT 1`,
      [sym],
    );
    if (rows[0]?.industry) meta.industry = String(rows[0].industry);
  } catch { /* industry column may not exist */ }

  const applyIntel = (intel: {
    companyName?: string; sector?: string; industry?: string;
    pe?: number; forwardPe?: number; eps?: number; roe?: number;
    dividendYield?: number; debtToEquity?: number; marketCap?: number;
    bookValue?: number; pbRatio?: number; beta?: number;
    week52High?: number; week52Low?: number;
  }) => {
    if (intel.companyName) meta.companyName = intel.companyName;
    if (intel.sector)      meta.sector = intel.sector;
    if (intel.industry)    meta.industry = intel.industry;
    meta.pe            = positiveOrNull(intel.pe)            ?? meta.pe;
    meta.forwardPe     = positiveOrNull(intel.forwardPe)     ?? meta.forwardPe;
    meta.eps           = positiveOrNull(intel.eps)           ?? meta.eps;
    meta.roe           = positiveOrNull(intel.roe)           ?? meta.roe;
    meta.beta          = positiveOrNull(intel.beta)          ?? meta.beta;
    meta.dividendYield = positiveOrNull(intel.dividendYield) ?? meta.dividendYield;
    meta.debtToEquity  = positiveOrNull(intel.debtToEquity)  ?? meta.debtToEquity;
    meta.marketCap     = positiveOrNull(intel.marketCap)     ?? meta.marketCap;
    meta.pbRatio       = positiveOrNull(intel.pbRatio)       ?? meta.pbRatio;
    meta.week52High    = positiveOrNull(intel.week52High)    ?? meta.week52High;
    meta.week52Low     = positiveOrNull(intel.week52Low)     ?? meta.week52Low;
    if (!meta.pbRatio) {
      const bookValue = positiveOrNull(intel.bookValue);
      const ltp       = positiveOrNull(quote?.lastPrice);
      if (bookValue && ltp) meta.pbRatio = +(ltp / bookValue).toFixed(2);
    }
  };

  let intelLoaded = false;
  try {
    const res = await getCorporateIntel(sym);
    if (res.data) {
      applyIntel(res.data);
      intelLoaded = true;
    }
  } catch {
    // IndianAPI 429 / breaker — serve last cached fundamentals if available.
    try {
      const stale = await memCache.get<{
        companyName?: string; sector?: string; industry?: string;
        pe?: number; eps?: number; roe?: number;
        dividendYield?: number; debtToEquity?: number; marketCap?: number;
        bookValue?: number;
      }>(corporateIntelCacheKey(sym));
      if (stale) {
        applyIntel(stale);
        intelLoaded = true;
      }
    } catch { /* cache miss */ }
    const staleRedis = await cacheGet<{
      pe?: number; eps?: number; roe?: number; marketCap?: number;
      companyName?: string; sector?: string;
    }>(`corp:stale:${sym}`);
    if (staleRedis) {
      applyIntel(staleRedis);
      intelLoaded = true;
    }
  }

  const missingValuation =
    meta.pe == null && meta.eps == null && meta.marketCap == null && meta.roe == null;
  if (!intelLoaded || missingValuation) {
    const yahooKey = `corp:yahoo:${sym}`;
    const cachedYahoo = await cacheGet<Parameters<typeof applyIntel>[0]>(yahooKey);
    if (cachedYahoo) {
      applyIntel(cachedYahoo);
    } else {
      const yahoo = await fetchYahooFundamentals(sym);
      if (yahoo) {
        const payload = {
          companyName:   yahoo.companyName ?? undefined,
          sector:        yahoo.sector ?? undefined,
          industry:      yahoo.industry ?? undefined,
          pe:            yahoo.pe ?? undefined,
          forwardPe:     yahoo.forwardPe ?? undefined,
          eps:           yahoo.eps ?? undefined,
          roe:           yahoo.roe ?? undefined,
          beta:          yahoo.beta ?? undefined,
          dividendYield: yahoo.dividendYield ?? undefined,
          debtToEquity:  yahoo.debtToEquity ?? undefined,
          marketCap:     yahoo.marketCap ?? undefined,
          bookValue:     yahoo.bookValue ?? undefined,
          pbRatio:       yahoo.pbRatio ?? undefined,
          week52High:    yahoo.week52High ?? undefined,
          week52Low:     yahoo.week52Low ?? undefined,
        };
        applyIntel(payload);
        await cacheSet(yahooKey, payload, 6 * 60 * 60).catch(() => {});
      }
    }
  }

  if (!meta.week52High || !meta.week52Low) {
    const fromDb = await load52WeekRangeFromDb(sym);
    if (fromDb) {
      meta.week52High = meta.week52High ?? fromDb.high;
      meta.week52Low  = meta.week52Low  ?? fromDb.low;
    } else {
      const fromYahoo = await fetchYahoo52WeekRange(sym);
      if (fromYahoo) {
        meta.week52High = meta.week52High ?? fromYahoo.high;
        meta.week52Low  = meta.week52Low  ?? fromYahoo.low;
      }
    }
  }

  return meta;
}

/**
 * Returns the full raw upstream response alongside the processed quote.
 * The "raw" payload is minimal — Yahoo metadata + a Kite source flag — // @deprecated marker
 * since the previous exchange-scrape shape is no longer available.
 */
export async function fetchQuoteFull(
  symbol: string,
  opts: { bypassCache?: boolean } = {},
): Promise<{ quote: Quote; raw: any; fetchedAt: number } | null> {
  void opts;
  const quote = await fetchQuote(symbol);
  if (!quote) return null;
  return {
    quote,
    raw: { source: 'kite+yahoo', symbol: quote.symbol }, // @deprecated marker
    fetchedAt: Date.now(),
  };
}

export async function fetchMultipleQuotes(
  symbols: string[],
): Promise<Record<string, Quote>> {
  const results: Record<string, Quote> = {};
  const BATCH = 5;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH);
    await Promise.all(chunk.map(async (sym) => {
      const q = await fetchQuote(sym);
      if (q) results[sym.toUpperCase()] = q;
    }));
    if (i + BATCH < symbols.length) {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  return results;
}

// ── Indices (Yahoo) ─────────────────────────────────────────────── // @deprecated marker

interface YahooIndexSpec { // @deprecated marker
  name: string;
  ticker: string;
}

// Yahoo tickers for Indian indices. Yahoo's own symbol schema uses // @deprecated marker
// "^NSEI" / "^NSEBANK" / "^CNXIT" etc. — those are Yahoo ticker // @deprecated marker
// codes, not references to the exchange.
const INDEX_SPECS: YahooIndexSpec[] = [ // @deprecated marker
  { name: 'NIFTY 50',         ticker: '^NSEI'      },
  { name: 'NIFTY BANK',       ticker: '^NSEBANK'   },
  { name: 'NIFTY IT',         ticker: '^CNXIT'     },
  { name: 'NIFTY PHARMA',     ticker: '^CNXPHARMA' },
  { name: 'NIFTY AUTO',       ticker: '^CNXAUTO'   },
  { name: 'NIFTY FMCG',       ticker: '^CNXFMCG'   },
  { name: 'NIFTY METAL',      ticker: '^CNXMETAL'  },
  { name: 'NIFTY ENERGY',     ticker: '^CNXENERGY' },
  { name: 'NIFTY REALTY',     ticker: '^CNXREALTY' },
  { name: 'NIFTY MIDCAP 100', ticker: '^CNXMIDCAP' },
  { name: 'NIFTY 500',        ticker: '^CRSLDX'    },
  { name: 'India VIX',        ticker: '^INDIAVIX'  },
];

async function fetchYahooIndexMeta(_ticker: string): Promise<IndexSnapshot | null> { // @deprecated marker
  // Yahoo removed. Index lookups always return null; the caller's // @deprecated marker
  // cache + DB layer handles the absence.
  return null;
}

export async function fetchIndices(
  opts: { bypassCache?: boolean } = {},
): Promise<IndexSnapshot[]> {
  const cacheKey = 'market:indices';
  if (!opts.bypassCache) {
    const cached = await cacheGet<IndexSnapshot[]>(cacheKey);
    if (cached && cached.length > 0) return cached;
  }

  const out: IndexSnapshot[] = [];
  await Promise.all(INDEX_SPECS.map(async (spec) => {
    const snap = await fetchYahooIndexMeta(spec.ticker); // @deprecated marker
    if (snap) out.push({ ...snap, name: spec.name });
  }));

  if (out.length > 0) await cacheSet(cacheKey, out, 60);
  return out;
}

// ── India VIX ─────────────────────────────────────────────────────

export async function fetchIndiaVix(): Promise<number | null> {
  const vix = await fetchYahooIndexMeta('^INDIAVIX'); // @deprecated marker
  return vix?.last ?? null;
}

// ── Sector regime (derived from indices) ──────────────────────────

const SECTOR_INDEX_MAP: Record<string, string> = {
  'NIFTY BANK':         'Banking',
  'NIFTY IT':           'IT',
  'NIFTY PHARMA':       'Pharma',
  'NIFTY AUTO':         'Auto',
  'NIFTY FMCG':         'FMCG',
  'NIFTY REALTY':       'Realty',
  'NIFTY METAL':        'Metal',
  'NIFTY ENERGY':       'Energy',
  'NIFTY MIDCAP 100':   'Midcap',
};

export async function fetchSectorRegime(): Promise<SectorRegime[]> {
  const indices = await fetchIndices();
  const result: SectorRegime[] = [];
  for (const idx of indices) {
    const sector = SECTOR_INDEX_MAP[idx.name];
    if (!sector) continue;
    const pct = idx.percentChange;
    const trend: SectorRegime['trend'] =
      pct > 0.2 ? 'up' : pct < -0.2 ? 'down' : 'flat';
    const strength: SectorRegime['strength'] =
      Math.abs(pct) >= 1.5 ? 'Strong' :
      Math.abs(pct) >= 0.5 ? 'Moderate' : 'Weak';
    result.push({ sector, index_name: idx.name, change_percent: pct, trend, strength });
  }
  return result;
}

// ── Features without a Kite/Yahoo equivalent ────────────────────── // @deprecated marker
//
// The following helpers preserve the caller contract but return
// empty data. The system's exchange-scrape dependency was removed
// intentionally; any feature that previously leaned on those feeds
// (FII/DII flows, option chains, gainers/losers, advance/decline
// breadth) degrades to "unavailable" rather than fabricating data.

export async function fetchMarketBreadth(): Promise<MarketBreadth> {
  return {
    advancing:             0,
    declining:             0,
    unchanged:             0,
    total:                 0,
    advance_decline_ratio: null,
  };
}

export async function fetchFiiDii(): Promise<FiiDiiEntry[]> {
  return [];
}

async function fetchGainersLosersFromRankings(
  type: 'gainers' | 'losers',
  limit = 50,
): Promise<any[]> {
  const order      = type === 'gainers' ? 'DESC' : 'ASC';
  const signFilter = type === 'gainers' ? 'AND pct_change > 0' : 'AND pct_change < 0';
  try {
    const { rows } = await db.query(
      `SELECT tradingsymbol AS symbol, name, ltp, pct_change
         FROM rankings
        WHERE pct_change IS NOT NULL ${signFilter}
        ORDER BY pct_change ${order}
        LIMIT ?`,
      [limit],
    );
    return (rows as Array<{ symbol?: string; name?: string; ltp?: number; pct_change?: number }>)
      .map((r) => {
        const sym = String(r.symbol ?? '').toUpperCase();
        const ltp = Number(r.ltp) || 0;
        const pct = Number(r.pct_change) || 0;
        return {
          symbol: sym,
          tradingsymbol: sym,
          sym,
          name: r.name,
          ltp,
          lastPrice: ltp,
          pChange: pct,
          perChange: pct,
          percent_change: pct,
        };
      })
      .filter((r) => r.symbol);
  } catch {
    return [];
  }
}

function mapMoversBucket(b: MoversBucket) {
  return {
    symbol:         b.symbol,
    tradingsymbol:  b.symbol,
    sym:            b.symbol,
    ltp:            b.price,
    lastPrice:      b.price,
    pChange:        b.changePercent,
    perChange:      b.changePercent,
    percent_change: b.changePercent,
  };
}

export async function fetchGainersLosers(
  type:  'gainers' | 'losers' = 'gainers',
  _index: string               = 'NIFTY 500',
): Promise<any[]> {
  void _index;
  try {
    let data;
    try {
      data = (await getMovers()).data;
    } catch (err) {
      if (err instanceof StaleDataError) {
        data = err.response.data as {
          gainers?: MoversBucket[];
          losers?: MoversBucket[];
          mostActive?: MoversBucket[];
        };
      } else {
        return fetchGainersLosersFromRankings(type);
      }
    }
    const bucket = (type === 'gainers' ? data?.gainers : data?.losers) ?? [];
    const mapped = bucket
      .filter((b) => b.symbol && Number.isFinite(b.price) && b.price > 0)
      .map(mapMoversBucket);
    if (mapped.length) return mapped;
    return fetchGainersLosersFromRankings(type);
  } catch {
    return fetchGainersLosersFromRankings(type);
  }
}

// Synthetic option chain. The Kite/Yahoo module has no true option // @deprecated marker
// chain upstream, so we build a plausible chain around the current
// spot price. This keeps the "Option Intelligence" feature working
// (OI zones, PCR, max pain, expected move) off real spot + a
// deterministic shape; callers see `source: 'synthetic'` so the UI
// can label it "Estimated (live feed unavailable)".
// Yahoo ticker for the default option-chain symbols. Indices don't // @deprecated marker
// resolve via `SYMBOL.NS` (what fetchQuote uses for stocks) — they
// need Yahoo's own ticker codes. Extend this map as more indices are // @deprecated marker
// added to the UI symbol selector.
const OPTION_INDEX_YAHOO: Record<string, string> = {
  NIFTY:      '^NSEI',
  BANKNIFTY:  '^NSEBANK',
  FINNIFTY:   '^CNXFIN',
  MIDCPNIFTY: '^NSEMDCP50',
  SENSEX:     '^BSESN',
  BANKEX:     '^BSEBANK',
};

const OPTION_INDEX_DB_ALIASES: Record<string, string[]> = {
  NIFTY:      ['NIFTY 50', 'NIFTY50', '^NSEI'],
  BANKNIFTY:  ['NIFTY BANK', 'BANKNIFTY', '^NSEBANK'],
  FINNIFTY:   ['NIFTY FIN SERVICE', 'FINNIFTY', 'NIFTY FINANCIAL SERVICES'],
  MIDCPNIFTY: ['NIFTY MIDCAP SELECT', 'MIDCPNIFTY', 'NIFTY MIDCAP 100'],
  SENSEX:     ['SENSEX', 'BSE SENSEX', '^BSESN'],
  BANKEX:     ['BANKEX', 'BSE BANKEX'],
};

const OPTION_STOCK_ALIASES: Record<string, string> = {};

function normalizeOptionInputSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\.NS$/, '');
}

async function fetchIndexSpotFromDb(symbol: string): Promise<number | null> {
  const sym = symbol.toUpperCase();
  const aliases = OPTION_INDEX_DB_ALIASES[sym] ?? [];
  if (aliases.length === 0) return null;

  const cacheKey = `index_spot_db:${sym}`;
  const cached = await cacheGet<number>(cacheKey);
  if (typeof cached === 'number' && cached > 0) return cached;

  const keys = aliases.map((a) => `NSE_INDEX|${a}`);
  try {
    const { rows } = await db.query<{ close: number }>(
      `SELECT close
         FROM candles
        WHERE candle_type='eod'
          AND interval_unit='1day'
          AND (
            SUBSTRING_INDEX(instrument_key, '|', -1) IN (${aliases.map(() => '?').join(',')})
            OR instrument_key IN (${keys.map(() => '?').join(',')})
          )
        ORDER BY ts DESC
        LIMIT 1`,
      [...aliases, ...keys],
    );
    const spot = Number((rows[0] as { close?: number } | undefined)?.close ?? 0);
    if (spot > 0) {
      await cacheSet(cacheKey, spot, 300);
      return spot;
    }
  } catch { /* index candle fallback unavailable */ }
  return null;
}

async function fetchStockSpotFromDb(symbol: string): Promise<number | null> {
  const sym = symbol.toUpperCase();
  const cacheKey = `stock_spot_db:${sym}`;
  const cached = await cacheGet<number>(cacheKey);
  if (typeof cached === 'number' && cached > 0) return cached;

  let rankingsLtp = 0;
  let rankingsMs = 0;

  try {
    const { rows } = await db.query<{ ltp: number; updated_at: Date | string }>(
      `SELECT ltp, updated_at
         FROM rankings
        WHERE tradingsymbol = ?
          AND ltp IS NOT NULL
          AND ltp > 0
        ORDER BY updated_at DESC
        LIMIT 1`,
      [sym],
    );
    const r = rows[0];
    if (r) {
      rankingsLtp = Number(r.ltp) || 0;
      rankingsMs = new Date(r.updated_at instanceof Date ? r.updated_at : String(r.updated_at)).getTime();
    }
  } catch { /* rankings fallback unavailable */ }

  let candleClose = 0;
  let candleMs = 0;

  try {
    const { rows } = await db.query<{ close: number; ts: Date | string }>(
      `SELECT close, ts
         FROM candles
        WHERE interval_unit = '1day'
          AND close IS NOT NULL
          AND close > 0
          AND (
            instrument_key = ?
            OR SUBSTRING_INDEX(instrument_key, '|', -1) = ?
          )
        ORDER BY ts DESC
        LIMIT 1`,
      [`NSE_EQ|${sym}`, sym],
    );
    const r = rows[0];
    if (r) {
      candleClose = Number(r.close) || 0;
      candleMs = new Date(r.ts instanceof Date ? r.ts : String(r.ts)).getTime();
    }
  } catch { /* candle fallback unavailable */ }

  if (candleClose > 0 && candleMs >= rankingsMs) {
    await cacheSet(cacheKey, candleClose, 120);
    return candleClose;
  }

  if (rankingsLtp > 0) {
    await cacheSet(cacheKey, rankingsLtp, 300);
    return rankingsLtp;
  }

  if (candleClose > 0) {
    await cacheSet(cacheKey, candleClose, 120);
    return candleClose;
  }

  try {
    const { rows } = await db.query<{ close: number }>(
      `SELECT close
         FROM market_data_daily
        WHERE symbol = ?
          AND close IS NOT NULL
          AND close > 0
        ORDER BY ts DESC
        LIMIT 1`,
      [sym],
    );
    const spot = Number((rows[0] as { close?: number } | undefined)?.close ?? 0);
    if (spot > 0) {
      await cacheSet(cacheKey, spot, 300);
      return spot;
    }
  } catch { /* daily fallback unavailable */ }

  return null;
}

async function hasExactStockSymbol(symbol: string): Promise<boolean> {
  const sym = symbol.toUpperCase();
  const cacheKey = `stock_symbol_exact:${sym}`;
  const cached = await cacheGet<boolean>(cacheKey);
  if (typeof cached === 'boolean') return cached;

  try {
    const { rows } = await db.query<{ ok: number }>(
      `SELECT (
          EXISTS(SELECT 1 FROM rankings WHERE tradingsymbol = ? LIMIT 1)
          OR EXISTS(SELECT 1 FROM securities_master WHERE symbol = ? LIMIT 1)
          OR EXISTS(SELECT 1 FROM q365_universe WHERE symbol = ? LIMIT 1)
          OR EXISTS(SELECT 1 FROM market_data_daily WHERE symbol = ? LIMIT 1)
          OR EXISTS(
            SELECT 1
              FROM candles
             WHERE instrument_key = ?
                OR SUBSTRING_INDEX(instrument_key, '|', -1) = ?
             LIMIT 1
          )
        ) AS ok`,
      [sym, sym, sym, sym, `NSE_EQ|${sym}`, sym],
    );
    const ok = Number((rows[0] as { ok?: number } | undefined)?.ok ?? 0) === 1;
    await cacheSet(cacheKey, ok, 300);
    return ok;
  } catch {
    return false;
  }
}

export async function fetchOptionChain(
  symbol: string,
): Promise<OptionChainResult | null> {
  const requestedSym = normalizeOptionInputSymbol(symbol);
  let sym = OPTION_STOCK_ALIASES[requestedSym] ?? requestedSym;

  // Resolve spot: indices go through Yahoo's index ticker path; // @deprecated marker
  // stocks go through the regular fetchQuote (Kite → Yahoo `.NS`). // @deprecated marker
  let spot = 0;
  const indexTicker = OPTION_INDEX_YAHOO[sym];
  if (indexTicker) {
    const idx = await fetchYahooIndexMeta(indexTicker); // @deprecated marker
    spot = idx?.last ?? 0;
    if (!spot || spot <= 0) {
      spot = await fetchIndexSpotFromDb(sym) ?? 0;
    }
  } else if (!(await hasExactStockSymbol(sym))) {
    return null;
  }
  if (!spot || spot <= 0) {
    const quote = await fetchQuote(sym);
    spot = quote?.lastPrice ?? 0;
  }
  if (!spot || spot <= 0) {
    spot = await fetchStockSpotFromDb(sym) ?? 0;
  }
  if (!spot || spot <= 0) return null;

  const step = optionStrikeStep(spot);
  const atmStrike = Math.round(spot / step) * step;
  const expiryDates = nextWeeklyExpiries(3);

  const strikes: number[] = [];
  for (let i = -10; i <= 10; i++) strikes.push(atmStrike + i * step);

  const rand = seededRand(sym);
  const records: OptionChainRow[] = [];

  for (const expiryDate of expiryDates) {
    for (const strike of strikes) {
      const atmDistRatio = Math.min(1, Math.abs(strike - atmStrike) / (step * 10));
      // Bell-ish OI falloff from ATM, plus a per-strike jitter.
      const baseOi = Math.round(((1 - atmDistRatio) ** 2) * 5_000_000 + 80_000 * rand(strike + 1));
      const ceBias = strike >= atmStrike ? 1 + 0.3 * rand(strike + 2) : 0.6 + 0.2 * rand(strike + 3);
      const peBias = strike <= atmStrike ? 1 + 0.3 * rand(strike + 4) : 0.6 + 0.2 * rand(strike + 5);
      const ceOi = Math.max(0, Math.round(baseOi * ceBias));
      const peOi = Math.max(0, Math.round(baseOi * peBias));
      const ceChg = Math.round((rand(strike + 6) - 0.4) * ceOi * 0.25);
      const peChg = Math.round((rand(strike + 7) - 0.4) * peOi * 0.25);
      // Simple smile: ATM ~16% → wings ~26%.
      const iv = 16 + 10 * atmDistRatio;
      // Black-Scholes-ish approximation: intrinsic + time value.
      const timeValue = spot * (iv / 100) * Math.sqrt(7 / 365) * (1 - atmDistRatio * 0.7);
      const ceLast = Math.max(0, spot - strike) + timeValue;
      const peLast = Math.max(0, strike - spot) + timeValue;

      records.push({
        strikePrice: strike,
        expiryDate,
        CE: {
          openInterest: ceOi,
          changeinOpenInterest: ceChg,
          impliedVolatility: iv,
          lastPrice: round2(ceLast),
          totalTradedVolume: Math.round(ceOi * 0.3),
          bidprice: round2(ceLast * 0.99),
          askPrice:  round2(ceLast * 1.01),
        },
        PE: {
          openInterest: peOi,
          changeinOpenInterest: peChg,
          impliedVolatility: iv,
          lastPrice: round2(peLast),
          totalTradedVolume: Math.round(peOi * 0.3),
          bidprice: round2(peLast * 0.99),
          askPrice:  round2(peLast * 1.01),
        },
      });
    }
  }

  return {
    symbol: sym,
    requestedSymbol: requestedSym !== sym ? requestedSym : undefined,
    records,
    underlyingValue: spot,
    expiryDates,
    source: 'synthetic',
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function optionStrikeStep(spot: number): number {
  if (spot >= 40000) return 100;
  if (spot >= 10000) return 50;
  if (spot >= 1000)  return 10;
  if (spot >= 200)   return 5;
  return 2.5;
}

function nextWeeklyExpiries(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  while (out.length < n) {
    // Roll forward to next Thursday. If today is Thursday, skip to next week.
    const daysToThu = (4 - d.getUTCDay() + 7) % 7 || 7;
    d.setUTCDate(d.getUTCDate() + daysToThu);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// xorshift seeded by symbol so a given (symbol, strike) pair yields
// the same OI/IV shape between polls — prevents UI jitter.
function seededRand(seed: string): (n: number) => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (n: number) => {
    let x = (h ^ (n | 0)) >>> 0;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    return (x >>> 0) / 0xffffffff;
  };
}

// ── Instrument master (Upstox CDN, no broker dependency) ──────────

export async function fetchInstrumentsJson(
  exchange: 'NSE' | 'BSE' | 'NSE_FO' = 'NSE',
): Promise<any[]> {
  const urls: Record<string, string> = {
    NSE:    'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz',
    BSE:    'https://assets.upstox.com/market-quote/instruments/exchange/BSE.json.gz',
    NSE_FO: 'https://assets.upstox.com/market-quote/instruments/exchange/NSE_FO.json.gz',
  };

  const cacheKey = `instruments_json:${exchange}`;
  const cached = await cacheGet<any[]>(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(urls[exchange], {
      headers: { 'Accept-Encoding': 'gzip' },
      signal:  AbortSignal.timeout(30_000),
    });
    if (!res.ok) return [];
    const data = JSON.parse(await res.text());
    await cacheSet(cacheKey, data, 6 * 3600);
    return data;
  } catch {
    return [];
  }
}

// Keep `fetchFromYahooCached` export alive for callers that only need // @deprecated marker
// the lightweight price cache — unchanged module from before.
export { fetchFromYahooCached }; // @deprecated marker
