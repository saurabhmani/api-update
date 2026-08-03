// ════════════════════════════════════════════════════════════════
//  IndianAPI mappers — normalize raw vendor payloads into the
//  canonical types from src/types/market.ts.
//
//  This is the authoritative field-name contract: if IndianAPI
//  renames a field, only this file changes. Nothing outside the
//  provider layer ever sees a Raw* shape.
// ════════════════════════════════════════════════════════════════

import type {
  CorporateIntel,
  HistoricalCandle,
  HistoricalRange,
  HistoricalSeries,
  MarketSnapshot,
  MoversBucket,
  MoversResult,
} from '@/types/market';
import type { IndianApiHistoricalPeriod } from './indianApiEndpoints';
import type {
  RawIndianApiBatchQuoteItem,
  RawIndianApiHistorical,
  RawIndianApiMoverItem,
  RawIndianApiStock,
  RawIndianApiTrending,
} from './indianApiTypes';

/** Tolerant numeric coercion: "1,234.55" → 1234.55; junk → 0. */
export function num(v: unknown): number {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** Prefer NSE price; fall back to BSE. */
function pickPrice(currentPrice: RawIndianApiStock['currentPrice']): number {
  if (currentPrice == null) return 0;
  if (typeof currentPrice === 'string' || typeof currentPrice === 'number') {
    return num(currentPrice);
  }
  const nse = num(currentPrice.NSE);
  if (nse > 0) return nse;
  return num(currentPrice.BSE);
}

export function mapStockToSnapshot(symbol: string, raw: RawIndianApiStock): MarketSnapshot {
  const price = pickPrice(raw.currentPrice);
  const prevClose = num(raw.previousClose);
  const changePercent = num(raw.percentChange);
  // Vendor gives percentChange, not absolute change — derive it.
  const change = prevClose > 0 ? (price - prevClose) : (price * changePercent) / 100;
  return {
    symbol: symbol.toUpperCase(),
    price,
    ltp: price,
    change,
    changePercent,
    volume: num(raw.volume),
    open: num(raw.open),
    high: num(raw.dayHigh),
    low: num(raw.dayLow),
    prevClose,
    timestamp: Date.now(),
  };
}

export function mapBatchItemToSnapshot(item: RawIndianApiBatchQuoteItem): MarketSnapshot | null {
  const symbol = (item.symbol || item.tickerId || '').toUpperCase().trim();
  if (!symbol) return null;
  const price = item.price != null
    ? num(item.price)
    : item.lastPrice != null
      ? num(item.lastPrice)
      : pickPrice(item.currentPrice as RawIndianApiStock['currentPrice']);
  if (price <= 0) return null;
  const prevClose = num(item.previousClose);
  const changePercent = num(item.percentChange);
  return {
    symbol,
    price,
    ltp: price,
    change: prevClose > 0 ? price - prevClose : (price * changePercent) / 100,
    changePercent,
    volume: num(item.volume),
    open: num(item.open),
    high: num(item.dayHigh),
    low: num(item.dayLow),
    prevClose,
    timestamp: Date.now(),
  };
}

export function mapStockToCorporateIntel(symbol: string, raw: RawIndianApiStock): CorporateIntel {
  return {
    symbol: symbol.toUpperCase(),
    companyName: raw.companyName || symbol.toUpperCase(),
    sector: raw.sector || undefined,
    industry: raw.industry || undefined,
    marketCap: num(raw.marketCap) || undefined,
    pe: num(raw.peRatio) || undefined,
    eps: num(raw.eps) || undefined,
    dividendYield: num(raw.dividendYield) || undefined,
    bookValue: num(raw.bookValue) || undefined,
    roe: num(raw.roe) || undefined,
    debtToEquity: num(raw.debtToEquity) || undefined,
  };
}

/** Canonical HistoricalRange → IndianAPI `period` query value. */
export function rangeToPeriod(range: HistoricalRange): IndianApiHistoricalPeriod {
  switch (range) {
    case '1d':
    case '5d':
    case '1mo': return '1m';
    case '3mo':
    case '6mo': return '6m';
    case '1y': return '1yr';
    case '5y': return '5yr';
    default: return '1yr';
  }
}

export function mapHistorical(
  symbol: string,
  range: HistoricalRange,
  raw: RawIndianApiHistorical,
): HistoricalSeries {
  const candles: HistoricalCandle[] = [];
  const priceDataset = raw.datasets?.find(
    d => (d.metric || d.label || '').toLowerCase().includes('price'),
  ) ?? raw.datasets?.[0];

  for (const point of priceDataset?.values ?? []) {
    let dateStr: string | undefined;
    let value: string | number | undefined;
    if (Array.isArray(point)) {
      [dateStr, value] = point;
    } else if (point && typeof point === 'object') {
      dateStr = point.date;
      value = point.value;
    }
    if (!dateStr) continue;
    const t = Date.parse(dateStr);
    const c = num(value);
    if (!Number.isFinite(t) || c <= 0) continue;
    // /historical_data (filter=price) provides close-only series —
    // OHLC collapse to close, volume unknown.
    candles.push({ t, o: c, h: c, l: c, c, v: 0 });
  }

  candles.sort((a, b) => a.t - b.t);
  return { symbol: symbol.toUpperCase(), range, candles };
}

function mapMoverItem(item: RawIndianApiMoverItem): MoversBucket | null {
  const symbol = (item.ticker_id || item.symbol || item.ric || '').toUpperCase().trim();
  if (!symbol) return null;
  return {
    symbol,
    price: num(item.price),
    changePercent: num(item.percent_change),
  };
}

export function mapTrendingToMovers(
  raw: RawIndianApiTrending,
  mostActive: RawIndianApiMoverItem[] = [],
): MoversResult {
  const gainers = (raw.trending_stocks?.top_gainers ?? [])
    .map(mapMoverItem)
    .filter((m): m is MoversBucket => m !== null);
  const losers = (raw.trending_stocks?.top_losers ?? [])
    .map(mapMoverItem)
    .filter((m): m is MoversBucket => m !== null);
  const active = mostActive
    .map(mapMoverItem)
    .filter((m): m is MoversBucket => m !== null);
  return { gainers, losers, mostActive: active };
}
