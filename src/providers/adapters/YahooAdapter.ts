// Yahoo adapter — public chart API (no API key).
// Used by the live feed poll loop and resolver emergency fallback.

import {
  fetchYahooPublicQuote,
  fetchYahooPublicQuotesBatch,
  type YahooPublicQuote,
} from '@/lib/marketData/yahooChartPublic';
import type {
  CorporateIntel,
  HistoricalRange,
  HistoricalSeries,
  IndustryPeer,
  MarketSnapshot,
  MoversResult,
  SymbolSearchHit,
} from '@/types/market';

function toSnapshot(q: YahooPublicQuote): MarketSnapshot {
  return {
    symbol:        q.symbol,
    price:         q.lastPrice,
    ltp:           q.lastPrice,
    change:        q.change,
    changePercent: q.pChange,
    volume:        q.volume,
    open:          q.open,
    high:          q.dayHigh,
    low:           q.dayLow,
    prevClose:     q.previousClose,
    timestamp:     q.timestamp,
  };
}

function removed(op: string): never {
  throw new Error(`YahooAdapter.${op}: not implemented — use fetchYahooQuotesBatch for live quotes`);
}

export async function getQuote(symbol: string): Promise<MarketSnapshot> {
  const q = await fetchYahooPublicQuote(symbol);
  if (!q || q.lastPrice <= 0) throw new Error(`YahooAdapter.getQuote: no data for ${symbol}`);
  return toSnapshot(q);
}

export async function getHistorical(
  _symbol: string,
  _range: HistoricalRange,
): Promise<HistoricalSeries> {
  return removed('getHistorical');
}

export async function searchSymbol(_query: string): Promise<SymbolSearchHit[]> {
  return removed('searchSymbol');
}

export async function getMovers(): Promise<MoversResult> {
  return removed('getMovers');
}

export async function getCorporateIntel(_symbol: string): Promise<CorporateIntel> {
  return removed('getCorporateIntel');
}

export async function getIndustryPeers(_symbol: string): Promise<IndustryPeer[]> {
  return removed('getIndustryPeers');
}

export async function fetchYahooQuotesBatch(
  symbols: string[],
  signal?: AbortSignal,
): Promise<MarketSnapshot[]> {
  const concurrency = Math.max(
    1,
    Math.min(20, Number(process.env.YAHOO_LIVE_CONCURRENCY) || 10),
  );
  const quotes = await fetchYahooPublicQuotesBatch(symbols, {
    concurrency,
    gapMs: Math.max(0, Number(process.env.YAHOO_LIVE_GAP_MS) || 120),
    signal,
  });
  return quotes.map(toSnapshot);
}
