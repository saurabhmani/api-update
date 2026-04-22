// ════════════════════════════════════════════════════════════════
//  IndianAPIAdapter — PRIMARY source
//
//  Responsibilities:
//    • Single-purpose: HTTP to indianapi.in and nothing else.
//    • Normalizes every payload into the canonical types from
//      /src/types/market.ts before returning.
//    • Never decides fallback policy — that's MarketDataProvider's
//      job. This adapter only returns data or throws.
//
//  ─────────────────────────────────────────────────────────────────
//  ⚠  INTEGRATION CHECKLIST — CONFIRM BEFORE PRODUCTION CUTOVER:
//
//    1. INDIANAPI_BASE_URL    → set in .env
//    2. INDIANAPI_KEY         → set in .env (sent as X-Api-Key header)
//    3. Endpoint paths below  → match the plan you subscribed to.
//       The shapes here reflect the public sample payloads from
//       indianapi.in docs at time of writing — verify against the
//       dashboard response samples before shipping.
//    4. Field names in response mappers → verify with a live
//       `curl` for one symbol and one historical range.
//
//  If any assumption is wrong, the fix is a one-file change HERE —
//  MarketDataProvider + engines are insulated by the type contract.
// ════════════════════════════════════════════════════════════════

import axios, { AxiosError, AxiosInstance } from 'axios';
import { logger } from '@/lib/logger';
import type {
  CorporateIntel,
  Fundamentals,
  HistoricalCandle,
  HistoricalRange,
  HistoricalSeries,
  IndustryPeer,
  MarketSnapshot,
  MoversBucket,
  MoversResult,
  SymbolSearchHit,
} from '@/types/market';

const log = logger.child({ adapter: 'IndianAPI' });

// Accept both naming conventions — `.env.example` and the
// market-ingestion service use `INDIAN_API_KEY` / `INDIAN_API_BASE_URL`,
// while early code in this adapter used `INDIANAPI_*`. Reading both
// keeps the Kite → IndianAPI fallback working regardless of which
// name the operator set in their .env.
const BASE_URL = process.env.INDIAN_API_BASE_URL?.trim() ||
                 process.env.INDIANAPI_BASE_URL?.trim() ||
                 'https://stock.indianapi.in';
const API_KEY  = process.env.INDIAN_API_KEY?.trim() ||
                 process.env.INDIANAPI_KEY?.trim() ||
                 '';
const TIMEOUT_MS = Number(process.env.INDIANAPI_TIMEOUT_MS ?? 2000);

if (!API_KEY) {
  // Soft warn: we don't want to crash an `npm run build` on CI that
  // doesn't have the key. The adapter will throw at call time instead.
  log.warn('INDIAN_API_KEY/INDIANAPI_KEY is not set — adapter will throw on every call until configured');
}

function http(): AxiosInstance {
  return axios.create({
    baseURL: BASE_URL,
    timeout: TIMEOUT_MS,
    headers: {
      'X-Api-Key': API_KEY,
      Accept: 'application/json',
    },
  });
}

// ── Raw response shapes (as documented by indianapi.in) ─────────────
//
// These are intentionally `any`-looking — we trust them only enough
// to extract the fields the mappers below actually reference, and the
// mapper itself is the authoritative contract. If IndianAPI changes
// a field name, only the mapper needs fixing.

interface RawStock {
  companyName?: string;
  tickerId?: string;
  currentPrice?: { BSE?: string; NSE?: string };
  percentChange?: string;
  yearHigh?: string;
  yearLow?: string;
  dayHigh?: string;
  dayLow?: string;
  volume?: string;
  open?: string;
  previousClose?: string;
  // Fundamentals (getCorporateIntel)
  industry?: string;
  sector?: string;
  marketCap?: string | number;
  peRatio?: string | number;
  eps?: string | number;
  dividendYield?: string | number;
  bookValue?: string | number;
  roe?: string | number;
  debtToEquity?: string | number;
}

function num(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function bestPrice(raw: RawStock): number {
  return num(raw.currentPrice?.NSE) || num(raw.currentPrice?.BSE);
}

// ── Public adapter surface ──────────────────────────────────────────

export class IndianAPIError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'IndianAPIError';
  }
}

async function request<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!API_KEY) {
    throw new IndianAPIError('INDIAN_API_KEY (or INDIANAPI_KEY) not configured');
  }
  try {
    const res = await http().get<T>(path, { params });
    return res.data;
  } catch (err) {
    const ax = err as AxiosError;
    const status = ax.response?.status;
    throw new IndianAPIError(
      `GET ${path} failed: ${ax.message}${status ? ` (status=${status})` : ''}`,
      status,
    );
  }
}

/**
 * Live snapshot for a single NSE/BSE symbol.
 * Endpoint assumption: GET /stock?name=<symbol>
 */
export async function getQuote(symbol: string): Promise<MarketSnapshot> {
  const sym = symbol.trim().toUpperCase();
  const raw = await request<RawStock>('/stock', { name: sym });

  const price      = bestPrice(raw);
  const prevClose  = num(raw.previousClose);
  const change     = prevClose > 0 ? price - prevClose : 0;
  const changePct  = num(raw.percentChange) ||
                     (prevClose > 0 ? (change / prevClose) * 100 : 0);

  return {
    symbol: sym,
    price,
    ltp: price,
    change,
    changePercent: changePct,
    volume: num(raw.volume),
    open: num(raw.open),
    high: num(raw.dayHigh),
    low:  num(raw.dayLow),
    prevClose,
    timestamp: Date.now(),
  };
}

/**
 * Historical OHLCV candles.
 * Endpoint assumption: GET /historical_data?stock_name=<sym>&period=<range>
 */
export async function getHistorical(
  symbol: string,
  range: HistoricalRange,
): Promise<HistoricalSeries> {
  const sym = symbol.trim().toUpperCase();
  const raw = await request<{
    datasets?: Array<{ metric?: string; values?: Array<[string, string]> }>;
  }>('/historical_data', { stock_name: sym, period: range });

  // IndianAPI returns parallel arrays keyed by metric (Price / Volume
  // / etc). We align them by date. If the shape differs on your plan,
  // this is the one block to rewrite.
  const byDate = new Map<string, Partial<HistoricalCandle> & { t: number }>();
  for (const ds of raw.datasets ?? []) {
    const metric = (ds.metric ?? '').toLowerCase();
    for (const [dateStr, valueStr] of ds.values ?? []) {
      const t = Date.parse(dateStr);
      if (!Number.isFinite(t)) continue;
      const bucket = byDate.get(dateStr) ?? { t };
      const v = num(valueStr);
      if (metric.includes('price')) bucket.c = v;
      else if (metric.includes('volume')) bucket.v = v;
      else if (metric.includes('high')) bucket.h = v;
      else if (metric.includes('low'))  bucket.l = v;
      else if (metric.includes('open')) bucket.o = v;
      byDate.set(dateStr, bucket);
    }
  }

  const candles: HistoricalCandle[] = [...byDate.values()]
    .map(b => ({
      t: b.t,
      o: b.o ?? b.c ?? 0,
      h: b.h ?? b.c ?? 0,
      l: b.l ?? b.c ?? 0,
      c: b.c ?? 0,
      v: b.v ?? 0,
    }))
    .sort((a, b) => a.t - b.t);

  return { symbol: sym, range, candles };
}

/** Endpoint assumption: GET /industry_search?query=<q> */
export async function searchSymbol(query: string): Promise<SymbolSearchHit[]> {
  const raw = await request<Array<{ symbol?: string; companyName?: string; exchange?: string; type?: string }>>(
    '/industry_search',
    { query },
  );
  return (raw ?? [])
    .filter(h => h.symbol)
    .map(h => ({
      symbol: String(h.symbol).toUpperCase(),
      name: h.companyName ?? h.symbol ?? '',
      exchange: h.exchange,
      type: h.type,
    }));
}

/** Endpoint assumption: GET /trending */
export async function getMovers(): Promise<MoversResult> {
  const raw = await request<{
    trending_stocks?: { top_gainers?: RawStock[]; top_losers?: RawStock[] };
  }>('/trending');
  const mapBucket = (s: RawStock): MoversBucket => ({
    symbol: String(s.tickerId ?? '').toUpperCase(),
    price: bestPrice(s),
    changePercent: num(s.percentChange),
  });
  return {
    gainers:    (raw.trending_stocks?.top_gainers ?? []).map(mapBucket),
    losers:     (raw.trending_stocks?.top_losers  ?? []).map(mapBucket),
    mostActive: [],  // not exposed on trending endpoint
  };
}

/** Endpoint assumption: GET /stock?name=<sym> (same payload as getQuote) */
export async function getCorporateIntel(symbol: string): Promise<CorporateIntel> {
  const sym = symbol.trim().toUpperCase();
  const raw = await request<RawStock>('/stock', { name: sym });
  return {
    symbol: sym,
    companyName: raw.companyName ?? sym,
    sector:   raw.sector,
    industry: raw.industry,
    marketCap:     num(raw.marketCap)      || undefined,
    pe:            num(raw.peRatio)        || undefined,
    eps:           num(raw.eps)            || undefined,
    dividendYield: num(raw.dividendYield)  || undefined,
    bookValue:     num(raw.bookValue)      || undefined,
    roe:           num(raw.roe)            || undefined,
    debtToEquity:  num(raw.debtToEquity)   || undefined,
  };
}

/**
 * Fundamentals — aggregates valuation, profitability, leverage, growth,
 * forecasts, and analyst targets into one normalized response.
 *
 * We intentionally fan out to three endpoints in parallel — /stock,
 * /stock_forecasts, /stock_target_price — because no single endpoint
 * returns everything this interface advertises. Callers get a
 * best-effort merge; missing fields stay `undefined` (never zeroed).
 */
export async function getFundamentals(symbol: string): Promise<Fundamentals> {
  const sym = symbol.trim().toUpperCase();
  interface RawForecast {
    revenue_growth_yoy?: number | string;
    earnings_growth_yoy?: number | string;
  }
  interface RawTarget {
    target_price?: number | string;
    rating_avg?: number | string;
    analyst_count?: number | string;
  }

  const [stock, forecasts, targets] = await Promise.all([
    request<RawStock & { pb?: unknown; ps?: unknown; peg?: unknown;
                         evToEbitda?: unknown; roa?: unknown; roce?: unknown;
                         netMargin?: unknown; operatingMargin?: unknown;
                         interestCoverage?: unknown; payoutRatio?: unknown;
                       }>('/stock', { name: sym }).catch(() => ({} as RawStock)),
    request<RawForecast>('/stock_forecasts',    { stock_name: sym }).catch(() => ({} as RawForecast)),
    request<RawTarget>('/stock_target_price', { stock_name: sym }).catch(() => ({} as RawTarget)),
  ]);

  return {
    symbol: sym,
    companyName: stock.companyName ?? sym,
    pe:            num((stock as RawStock).peRatio) || undefined,
    pb:            num((stock as { pb?: unknown }).pb) || undefined,
    ps:            num((stock as { ps?: unknown }).ps) || undefined,
    peg:           num((stock as { peg?: unknown }).peg) || undefined,
    evToEbitda:    num((stock as { evToEbitda?: unknown }).evToEbitda) || undefined,
    roe:           num(stock.roe) || undefined,
    roa:           num((stock as { roa?: unknown }).roa) || undefined,
    roce:          num((stock as { roce?: unknown }).roce) || undefined,
    netMargin:     num((stock as { netMargin?: unknown }).netMargin) || undefined,
    operatingMargin: num((stock as { operatingMargin?: unknown }).operatingMargin) || undefined,
    debtToEquity:  num(stock.debtToEquity) || undefined,
    interestCoverage: num((stock as { interestCoverage?: unknown }).interestCoverage) || undefined,
    revenueGrowthYoY:  num(forecasts.revenue_growth_yoy)  || undefined,
    earningsGrowthYoY: num(forecasts.earnings_growth_yoy) || undefined,
    dividendYield: num(stock.dividendYield) || undefined,
    payoutRatio:   num((stock as { payoutRatio?: unknown }).payoutRatio) || undefined,
    analystTargetPrice: num(targets.target_price)  || undefined,
    analystRatingAvg:   num(targets.rating_avg)    || undefined,
    analystCount:       num(targets.analyst_count) || undefined,
    asOf: Date.now(),
  };
}

/** Endpoint assumption: GET /industry_peers?stock_name=<sym> */
export async function getIndustryPeers(symbol: string): Promise<IndustryPeer[]> {
  const sym = symbol.trim().toUpperCase();
  const raw = await request<Array<RawStock>>('/industry_peers', { stock_name: sym });
  return (raw ?? []).map(p => ({
    symbol: String(p.tickerId ?? '').toUpperCase(),
    name: p.companyName ?? '',
    price: bestPrice(p),
    changePercent: num(p.percentChange),
    marketCap: num(p.marketCap) || undefined,
    pe:        num(p.peRatio)   || undefined,
  }));
}

// ════════════════════════════════════════════════════════════════
//  Additional documented endpoints (indianapi.in/documentation)
//
//  These are lighter-touch wrappers — the upstream payload shape is
//  passed through as `unknown`-typed records. Callers that want
//  canonical shapes for mutual funds / commodities / etc. should add
//  mappers in this file once those types land in /src/types/market.ts.
// ════════════════════════════════════════════════════════════════

/** GET /mutual_fund_search?query=<q> */
export async function searchMutualFunds(query: string): Promise<unknown[]> {
  const raw = await request<unknown>('/mutual_fund_search', { query });
  return Array.isArray(raw) ? raw : [];
}

/** GET /mutual_funds — latest data for all mutual funds (NAV, returns, etc.) */
export async function getMutualFunds(): Promise<unknown> {
  return request<unknown>('/mutual_funds');
}

/** GET /fetch_52_week_high_low_data */
export async function get52WeekHighLow(): Promise<unknown> {
  return request<unknown>('/fetch_52_week_high_low_data');
}

/** GET /NSE_most_active — most active NSE stocks by volume */
export async function getNseMostActive(): Promise<MoversBucket[]> {
  const raw = await request<RawStock[]>('/NSE_most_active');
  return (raw ?? []).map(s => ({
    symbol: String(s.tickerId ?? s.companyName ?? '').toUpperCase(),
    price: bestPrice(s),
    changePercent: num(s.percentChange),
  }));
}

/** GET /BSE_most_active — most active BSE stocks by volume */
export async function getBseMostActive(): Promise<MoversBucket[]> {
  const raw = await request<RawStock[]>('/BSE_most_active');
  return (raw ?? []).map(s => ({
    symbol: String(s.tickerId ?? s.companyName ?? '').toUpperCase(),
    price: bestPrice(s),
    changePercent: num(s.percentChange),
  }));
}

/**
 * GET /price_shockers — returns a flat list of symbols (NSE/BSE) that
 * made outsized short-window moves. Consumed by the triggerEngine.
 *
 * Payload normalizes across two documented shapes: `{ stocks: [...] }`
 * and a bare top-level array.
 */
export async function getPriceShockers(): Promise<string[]> {
  const raw = await request<
    { stocks?: Array<{ symbol?: string; tickerId?: string }> } |
    Array<{ symbol?: string; tickerId?: string }>
  >('/price_shockers');   // TODO: verify path against your IndianAPI plan
  const list = Array.isArray(raw) ? raw : (raw.stocks ?? []);
  return list
    .map(r => String(r.symbol ?? r.tickerId ?? '').toUpperCase())
    .filter(Boolean);
}

/** GET /commodities — snapshot of active commodity futures contracts */
export async function getCommodities(): Promise<unknown> {
  return request<unknown>('/commodities');
}

/** GET /stock_target_price?stock_id=<id> — analyst targets + ratings */
export async function getStockTargetPrice(stockId: string): Promise<unknown> {
  return request<unknown>('/stock_target_price', { stock_id: stockId });
}

/**
 * GET /stock_forecasts — forecast detail per stock + measure.
 * `measure_code`, `period_type`, `data_type`, `age` are required by the
 * upstream contract. Defaults mirror the IndianAPI sample requests.
 */
export async function getStockForecasts(
  stockId: string,
  opts: {
    measureCode?: string;
    periodType?: string;
    dataType?: string;
    age?: string;
  } = {},
): Promise<unknown> {
  return request<unknown>('/stock_forecasts', {
    stock_id:     stockId,
    measure_code: opts.measureCode ?? 'EPS',
    period_type:  opts.periodType  ?? 'Annual',
    data_type:    opts.dataType    ?? 'Actuals',
    age:          opts.age         ?? 'OneYear',
  });
}

/**
 * GET /historical_stats?stock_name=<sym>&stats=<key>
 * `stats` selects which financial statistic series to return
 * (e.g. 'quarter_results', 'profit_loss', 'balance_sheet', 'cash_flow').
 */
export async function getHistoricalStats(
  symbol: string,
  stats: string,
): Promise<unknown> {
  const sym = symbol.trim().toUpperCase();
  return request<unknown>('/historical_stats', { stock_name: sym, stats });
}

// ════════════════════════════════════════════════════════════════════
//  Tiered-scheduler additions (Priority 1B quota-reduction refactor).
//
//  These methods power the batchScheduler's Tier A (market-wide cheap
//  endpoints + batch quotes), Tier B (news-aware trigger scoring), and
//  Tier C (news/intel) phases. They are called through MarketDataProvider
//  wrappers that apply budget-guard spend() accounting — never from
//  engines or routes directly.
// ════════════════════════════════════════════════════════════════════

/** Unified news row returned by both /market_news and /stock_news. */
export interface NewsItem {
  /** Present only for company-specific news. */
  symbol?: string;
  headline: string;
  source?: string;
  url?: string;
  /** epoch ms */
  publishedAt: number;
  summary?: string;
}

/** Result envelope for getBatchQuotes — snapshots[] holds every symbol
 *  the upstream returned; missing[] lists symbols we asked for but the
 *  upstream omitted. */
export interface BatchQuoteResult {
  snapshots: MarketSnapshot[];
  missing: string[];
}

// Chunk size respects IndianAPI's documented batch cap. If the plan
// exposes a different limit, tune via env later — 200 is a safe default.
const BATCH_CHUNK_LIMIT = 200;

/**
 * GET /nse/batch_quote?symbols=SYM1,SYM2,...
 *
 * Batch live snapshot endpoint. The adapter chunks to BATCH_CHUNK_LIMIT
 * and concatenates results; missing symbols are reported in the
 * returned envelope rather than silently dropped.
 *
 * If your IndianAPI plan exposes a POST form or different path,
 * adjust the `request` call below — the mapping layer is shape-tolerant.
 */
export async function getBatchQuotes(symbols: string[]): Promise<BatchQuoteResult> {
  const clean = [...new Set(
    symbols.map(s => s.trim().toUpperCase()).filter(Boolean),
  )];
  if (clean.length === 0) return { snapshots: [], missing: [] };

  const chunks: string[][] = [];
  for (let i = 0; i < clean.length; i += BATCH_CHUNK_LIMIT) {
    chunks.push(clean.slice(i, i + BATCH_CHUNK_LIMIT));
  }

  const snapshots: MarketSnapshot[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    // TODO: confirm path + query param name against IndianAPI docs.
    const raw = await request<{ data?: RawBatchRow[] } | RawBatchRow[]>(
      '/nse/batch_quote',
      { symbols: chunk.join(',') },
    );
    const rows = Array.isArray(raw) ? raw : (raw.data ?? []);
    for (const row of rows) {
      const mapped = mapBatchRow(row);
      if (!mapped) continue;
      snapshots.push(mapped);
      seen.add(mapped.symbol);
    }
  }

  const missing = clean.filter(s => !seen.has(s));
  if (missing.length) {
    log.info('batch quote missing symbols', { count: missing.length, sample: missing.slice(0, 5) });
  }

  return { snapshots, missing };
}

interface RawBatchRow {
  symbol?: string;
  tickerId?: string;
  companyName?: string;
  price?: string | number;
  ltp?: string | number;
  lastPrice?: string | number;
  currentPrice?: { NSE?: string | number; BSE?: string | number } | string | number;
  percentChange?: string | number;
  change?: string | number;
  volume?: string | number;
  open?: string | number;
  dayHigh?: string | number;
  high?: string | number;
  dayLow?: string | number;
  low?: string | number;
  previousClose?: string | number;
  prevClose?: string | number;
  yearHigh?: string | number;
  yearLow?: string | number;
  timestamp?: string | number;
}

function mapBatchRow(r: RawBatchRow): MarketSnapshot | null {
  const sym = String(r.symbol ?? r.tickerId ?? '').trim().toUpperCase();
  if (!sym) return null;

  let price: number;
  if (typeof r.currentPrice === 'object' && r.currentPrice !== null) {
    price = num(r.currentPrice.NSE) || num(r.currentPrice.BSE);
  } else {
    price = num(r.currentPrice) || num(r.price) || num(r.ltp) || num(r.lastPrice);
  }
  const prevClose = num(r.previousClose ?? r.prevClose);
  const change = num(r.change) || (prevClose > 0 ? price - prevClose : 0);
  const changePct = num(r.percentChange) ||
    (prevClose > 0 ? (change / prevClose) * 100 : 0);

  return {
    symbol: sym,
    price,
    ltp: price,
    change,
    changePercent: changePct,
    volume: num(r.volume),
    open: num(r.open),
    high: num(r.dayHigh ?? r.high),
    low:  num(r.dayLow  ?? r.low),
    prevClose,
    timestamp: num(r.timestamp) || Date.now(),
  };
}

/**
 * Flat list of trending symbols (gainers ∪ losers). Reuses the
 * /trending endpoint since that's the one confirmed on our IndianAPI
 * plan; the old /trending_stocks path 404s. Cheaper than a separate
 * call — the trigger engine only needs the symbol set, not the full
 * gainer/loser payload.
 */
export async function getTrendingSymbols(): Promise<string[]> {
  const raw = await request<{
    trending_stocks?: { top_gainers?: RawStock[]; top_losers?: RawStock[] };
  }>('/trending');
  const symbols = new Set<string>();
  for (const s of raw.trending_stocks?.top_gainers ?? []) {
    const sym = String(s.tickerId ?? '').toUpperCase();
    if (sym) symbols.add(sym);
  }
  for (const s of raw.trending_stocks?.top_losers ?? []) {
    const sym = String(s.tickerId ?? '').toUpperCase();
    if (sym) symbols.add(sym);
  }
  return [...symbols];
}

/** GET /market_news — market-wide headlines. */
export async function getMarketNews(): Promise<NewsItem[]> {
  const raw = await request<{ news?: RawNewsRow[] } | RawNewsRow[]>('/market_news');   // TODO: verify path
  const list = Array.isArray(raw) ? raw : (raw.news ?? []);
  return list.map(mapNewsRow);
}

/** GET /stock_news?stock_name=<sym> — company-specific news. */
export async function getCompanyNews(symbol: string): Promise<NewsItem[]> {
  const sym = symbol.trim().toUpperCase();
  const raw = await request<{ news?: RawNewsRow[] } | RawNewsRow[]>(
    '/stock_news',   // TODO: verify path
    { stock_name: sym },
  );
  const list = Array.isArray(raw) ? raw : (raw.news ?? []);
  return list.map(r => ({ ...mapNewsRow(r), symbol: sym }));
}

interface RawNewsRow {
  symbol?: string;
  headline?: string;
  title?: string;
  source?: string;
  url?: string;
  link?: string;
  publishedAt?: string | number;
  date?: string;
  summary?: string;
  description?: string;
}

function mapNewsRow(r: RawNewsRow): NewsItem {
  const publishedAt = typeof r.publishedAt === 'number'
    ? r.publishedAt
    : (r.publishedAt
        ? Date.parse(String(r.publishedAt))
        : (r.date ? Date.parse(r.date) : Date.now()));
  return {
    symbol:   r.symbol?.toUpperCase(),
    headline: String(r.headline ?? r.title ?? ''),
    source:   r.source,
    url:      r.url ?? r.link,
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
    summary:  r.summary ?? r.description,
  };
}
