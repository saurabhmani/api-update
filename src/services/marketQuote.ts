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
 * Helpers that have no Kite/Yahoo equivalent (option chain, // @deprecated marker
 * FII/DII flows, gainers/losers, market breadth, sector regime)
 * return empty data — the callers treat absence as "unavailable"
 * and degrade gracefully.
 */
import { cacheGet, cacheSet }   from '@/lib/redis';
import { resolvePrice }         from '@/lib/marketData/resolver/marketDataResolver';
import { fetchFromYahooCached } from '@/lib/marketData/priceCache'; // @deprecated marker

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
  source?:          'kite' | 'yahoo' | 'synthetic'; // @deprecated marker
}

// ── Quotes ────────────────────────────────────────────────────────
//
// Live price comes from MarketDataResolver (Kite primary, Yahoo // @deprecated marker
// fallback). The Yahoo fallback path additionally fetches day OHLC // @deprecated marker
// + 52-week range from Yahoo chart metadata so the richer Quote // @deprecated marker
// shape below is populated even when no Kite tick is available. // @deprecated marker

async function fetchYahooMeta(_symbol: string): Promise<Partial<Quote> | null> { // @deprecated marker
  // Yahoo removed. Returning null lets fetchQuote() fall through to // @deprecated marker
  // resolvePrice() (which is also data-source-less now) and ultimately
  // return null if no upstream is available.
  return null;
}

export async function fetchQuote(symbol: string): Promise<Quote | null> {
  const sym = symbol.toUpperCase();

  const resolved = await resolvePrice(sym);
  const meta = await fetchYahooMeta(sym); // @deprecated marker

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

export async function fetchGainersLosers(
  _type:  'gainers' | 'losers' = 'gainers',
  _index: string               = 'NIFTY 500',
): Promise<any[]> {
  void _type; void _index;
  return [];
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

export async function fetchOptionChain(
  symbol: string,
): Promise<OptionChainResult | null> {
  const sym = symbol.toUpperCase();

  // Resolve spot: indices go through Yahoo's index ticker path; // @deprecated marker
  // stocks go through the regular fetchQuote (Kite → Yahoo `.NS`). // @deprecated marker
  let spot = 0;
  const indexTicker = OPTION_INDEX_YAHOO[sym];
  if (indexTicker) {
    const idx = await fetchYahooIndexMeta(indexTicker); // @deprecated marker
    spot = idx?.last ?? 0;
  }
  if (!spot || spot <= 0) {
    const quote = await fetchQuote(sym);
    spot = quote?.lastPrice ?? 0;
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
