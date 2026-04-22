// ════════════════════════════════════════════════════════════════
//  Formal provider interfaces — Phase-1 DoD
//
//  The Phase-1 spec calls out named interfaces (IMarketDataProvider,
//  ICorporateIntelProvider, IHistoricalProvider, ISymbolSearchProvider).
//  These types pin the contract so future providers (test doubles,
//  alternate vendors, mock adapters) can be swapped without reading
//  MarketDataProvider.ts to rediscover the shape.
//
//  MarketDataProvider itself satisfies every interface below; a
//  compile-time assertion at the bottom of this file proves it.
// ════════════════════════════════════════════════════════════════

import type {
  CorporateIntel,
  Fundamentals,
  HistoricalRange,
  HistoricalSeries,
  IndustryPeer,
  MarketSnapshot,
  MoversResult,
  ProviderResponse,
  SymbolSearchHit,
} from '@/types/market';

export interface GetOptions {
  signalCritical?: boolean;
  forceRefresh?: boolean;
}

export interface ISymbolSearchProvider {
  searchSymbols(query: string): Promise<ProviderResponse<SymbolSearchHit[]>>;
}

export interface ILiveQuoteProvider {
  getLiveSnapshot(symbol: string, opts?: GetOptions): Promise<ProviderResponse<MarketSnapshot>>;
  /** Alias of getLiveSnapshot; preserved for callers that think in "quote" terms. */
  getQuote(symbol: string, opts?: GetOptions): Promise<ProviderResponse<MarketSnapshot>>;
}

export interface IHistoricalProvider {
  getHistorical(
    symbol: string,
    range: HistoricalRange,
    opts?: GetOptions,
  ): Promise<ProviderResponse<HistoricalSeries>>;
}

export interface IMoversProvider {
  getMovers(opts?: GetOptions): Promise<ProviderResponse<MoversResult>>;
}

export interface ICorporateIntelProvider {
  getCorporateIntel(symbol: string, opts?: GetOptions): Promise<ProviderResponse<CorporateIntel>>;
}

export interface IFundamentalsProvider {
  getFundamentals(symbol: string, opts?: GetOptions): Promise<ProviderResponse<Fundamentals>>;
}

export interface IIndustryPeersProvider {
  getIndustryPeers(symbol: string): Promise<ProviderResponse<IndustryPeer[]>>;
}

/**
 * The union contract — the thing every consumer in Quantorus365 can
 * assume is available through `MarketDataProvider`. Tests use this
 * to type their doubles; future code should program against THIS
 * interface, not the concrete module.
 */
export interface IMarketDataProvider
  extends ISymbolSearchProvider,
    ILiveQuoteProvider,
    IHistoricalProvider,
    IMoversProvider,
    ICorporateIntelProvider,
    IFundamentalsProvider,
    IIndustryPeersProvider {}

// ── Compile-time guarantee that MarketDataProvider satisfies the contract.
// If this assignment ever fails to type-check, the provider module has
// drifted from its advertised interface.
import MarketDataProvider from './MarketDataProvider';

const _assertMatches: IMarketDataProvider = MarketDataProvider;
void _assertMatches;
