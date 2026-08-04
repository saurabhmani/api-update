export type MarketDataFreshness = 'fresh' | 'aging' | 'stale' | 'unknown';
export type MarketDataCacheStatus = 'hit' | 'miss' | 'bypassed' | 'unknown';
export type MarketDataDelivery = 'real-time' | 'delayed' | 'snapshot' | 'unknown';
export type MarketDataAdjustment = 'adjusted' | 'unadjusted' | 'unknown';

export interface CanonicalInstrumentIdentity {
  symbol: string;
  exchange?: string;
  instrumentKey?: string;
  providerSymbol?: string;
}

export interface MarketDataQuote {
  instrument: CanonicalInstrumentIdentity;
  value: number | null;
  quoteTimestamp?: string | null;
  sourceTimestamp?: string | null;
  retrievedAt: string;
  provider: string;
  freshness: MarketDataFreshness;
  stale: boolean;
  cache: MarketDataCacheStatus;
  marketStatus?: string;
  delivery: MarketDataDelivery;
  fallbackProviders?: string[];
}

export interface HistoricalCandleContract {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  interval: string;
  adjustment: MarketDataAdjustment;
  provider?: string;
}

export type MarketDataErrorCategory =
  | 'INVALID_INSTRUMENT'
  | 'MARKET_CLOSED'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'STALE_DATA'
  | 'NO_DATA'
  | 'UNKNOWN';

export interface MarketDataVersionMetadata {
  contractVersion: '1.0.0';
  implementation: 'quantorus365-market-data-resolver';
}
