/**
 * Market Quote Service — Kite + Yahoo only
 *
 * Unified helpers for live quotes, indices, India VIX, and the
 * instrument master. This replaces the earlier dedicated exchange-
 * scraping module; the system now consults only two upstreams:
 *
 *   • Kite (real-time WebSocket ticks, via MarketDataResolver)
 *   • Yahoo Finance (15-min-delayed fallback + indices + VIX)
 *
 * Helpers that have no Kite/Yahoo equivalent (option chain,
 * FII/DII flows, gainers/losers, market breadth, sector regime)
 * return empty data — the callers treat absence as "unavailable"
 * and degrade gracefully.
 */
import { cacheGet, cacheSet }   from '@/lib/redis';
import { resolvePrice }         from '@/lib/marketData/MarketDataResolver';
import { fetchFromYahooCached } from '@/lib/marketData/priceCache';

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
  records:          OptionChainRow[];
  underlyingValue:  number;
  expiryDates:      string[];
  source?:          'kite' | 'yahoo' | 'synthetic';
}

// ── Quotes ────────────────────────────────────────────────────────
//
// Live price comes from MarketDataResolver (Kite primary, Yahoo
// fallback). The Yahoo fallback path additionally fetches day OHLC
// + 52-week range from Yahoo chart metadata so the richer Quote
// shape below is populated even when no Kite tick is available.

const YAHOO_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://finance.yahoo.com/',
};

async function fetchYahooMeta(symbol: string): Promise<Partial<Quote> | null> {
  const ySym = `${symbol.toUpperCase()}.NS`;
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const res = await fetch(
        `https://${host}/v8/finance/chart/${encodeURIComponent(ySym)}?interval=1d&range=5d`,
        { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) continue;
      const json = await res.json();
      const result = json?.chart?.result?.[0];
      const meta = result?.meta;
      if (!meta) continue;
      const ltp = Number(meta.regularMarketPrice ?? meta.previousClose ?? 0);
      const prev = Number(meta.chartPreviousClose ?? meta.previousClose ?? 0);
      const change = prev > 0 ? ltp - prev : 0;
      const pChange = prev > 0 ? (change / prev) * 100 : 0;
      return {
        symbol:            symbol.toUpperCase(),
        lastPrice:         ltp,
        change,
        pChange,
        open:              Number(meta.regularMarketOpen ?? 0),
        dayHigh:           Number(meta.regularMarketDayHigh ?? ltp),
        dayLow:            Number(meta.regularMarketDayLow  ?? ltp),
        previousClose:     prev,
        totalTradedVolume: Number(meta.regularMarketVolume ?? 0),
        totalTradedValue:  0,
        fiftyTwoWeekHigh:  Number(meta.fiftyTwoWeekHigh ?? 0),
        fiftyTwoWeekLow:   Number(meta.fiftyTwoWeekLow  ?? 0),
      };
    } catch { /* try next host */ }
  }
  return null;
}

export async function fetchQuote(symbol: string): Promise<Quote | null> {
  const sym = symbol.toUpperCase();

  const resolved = await resolvePrice(sym);
  const meta = await fetchYahooMeta(sym);

  if (!meta && (resolved.price == null || resolved.price <= 0)) return null;

  const ltp     = resolved.price ?? meta?.lastPrice ?? 0;
  const pChange = resolved.pChange ?? meta?.pChange ?? 0;
  const change  = meta?.change ?? 0;

  return {
    symbol:            sym,
    lastPrice:         ltp,
    change,
    pChange,
    open:              meta?.open              ?? 0,
    dayHigh:           meta?.dayHigh           ?? ltp,
    dayLow:            meta?.dayLow            ?? ltp,
    previousClose:     meta?.previousClose     ?? 0,
    totalTradedVolume: meta?.totalTradedVolume ?? 0,
    totalTradedValue:  meta?.totalTradedValue  ?? 0,
    fiftyTwoWeekHigh:  meta?.fiftyTwoWeekHigh  ?? 0,
    fiftyTwoWeekLow:   meta?.fiftyTwoWeekLow   ?? 0,
  };
}

/**
 * Returns the full raw upstream response alongside the processed quote.
 * The "raw" payload is minimal — Yahoo metadata + a Kite source flag —
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
    raw: { source: 'kite+yahoo', symbol: quote.symbol },
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

// ── Indices (Yahoo) ───────────────────────────────────────────────

interface YahooIndexSpec {
  name: string;
  ticker: string;
}

// Yahoo tickers for Indian indices. Yahoo's own symbol schema uses
// "^NSEI" / "^NSEBANK" / "^CNXIT" etc. — those are Yahoo ticker
// codes, not references to the exchange.
const INDEX_SPECS: YahooIndexSpec[] = [
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

async function fetchYahooIndexMeta(ticker: string): Promise<IndexSnapshot | null> {
  for (const host of ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']) {
    try {
      const res = await fetch(
        `https://${host}/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d`,
        { headers: YAHOO_HEADERS, signal: AbortSignal.timeout(8_000) },
      );
      if (!res.ok) continue;
      const json = await res.json();
      const meta = json?.chart?.result?.[0]?.meta;
      if (!meta) continue;
      const last = Number(meta.regularMarketPrice ?? meta.previousClose ?? 0);
      const prev = Number(meta.chartPreviousClose ?? meta.previousClose ?? 0);
      const variation = prev > 0 ? last - prev : 0;
      const pct = prev > 0 ? (variation / prev) * 100 : 0;
      return {
        name:          '',
        last,
        variation,
        percentChange: pct,
        open:          Number(meta.regularMarketOpen    ?? 0),
        high:          Number(meta.regularMarketDayHigh ?? 0),
        low:           Number(meta.regularMarketDayLow  ?? 0),
        previousClose: prev,
        yearHigh:      Number(meta.fiftyTwoWeekHigh     ?? 0),
        yearLow:       Number(meta.fiftyTwoWeekLow      ?? 0),
      };
    } catch { /* try next host */ }
  }
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
    const snap = await fetchYahooIndexMeta(spec.ticker);
    if (snap) out.push({ ...snap, name: spec.name });
  }));

  if (out.length > 0) await cacheSet(cacheKey, out, 60);
  return out;
}

// ── India VIX ─────────────────────────────────────────────────────

export async function fetchIndiaVix(): Promise<number | null> {
  const vix = await fetchYahooIndexMeta('^INDIAVIX');
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

// ── Features without a Kite/Yahoo equivalent ──────────────────────
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

export async function fetchGainersLosers(
  _type:  'gainers' | 'losers' = 'gainers',
  _index: string               = 'NIFTY 500',
): Promise<any[]> {
  void _type; void _index;
  return [];
}

export async function fetchOptionChain(
  _symbol: string,
): Promise<OptionChainResult | null> {
  void _symbol;
  return null;
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

// Keep `fetchFromYahooCached` export alive for callers that only need
// the lightweight price cache — unchanged module from before.
export { fetchFromYahooCached };
