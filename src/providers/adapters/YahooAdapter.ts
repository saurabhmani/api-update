// ════════════════════════════════════════════════════════════════
//  YahooAdapter — NEUTRALIZED STUB // @deprecated marker
//  @deprecated — only invoked from MarketDataProvider when
//  YAHOO_EMERGENCY_FALLBACK_ENABLED=true. New code must not import.
//
//  Yahoo Finance integration has been removed. The provider-framework // @deprecated marker
//  adapter's public surface is preserved so the orchestrator
//  (MarketDataProvider, etc.) compiles, but every method throws
//  `yahoo_removed` — the chain naturally falls through to the next // @deprecated marker
//  adapter (cache → DB) on every call.
// ════════════════════════════════════════════════════════════════

import type {
  CorporateIntel,
  HistoricalRange,
  HistoricalSeries,
  IndustryPeer,
  MarketSnapshot,
  MoversResult,
  SymbolSearchHit,
} from '@/types/market';

function removed(op: string): never {
  throw new Error(`YahooAdapter.${op}: yahoo_removed`); // @deprecated marker
}

export async function getQuote(_symbol: string): Promise<MarketSnapshot> { // @deprecated marker
  return removed('getQuote'); // @deprecated marker
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
  _symbols: string[],
  _signal?: AbortSignal,
): Promise<MarketSnapshot[]> {
  return removed('fetchYahooQuotesBatch');
}
