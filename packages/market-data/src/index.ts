/** Stable facade over the active resolver. Provider policy remains unchanged. */
export {
  resolveSingle as getQuote,
  resolveBatch as getQuotes,
  resolvePrice,
  resolvePrices,
  resolve,
  summarizeQuality,
  buildSmartFallbackEnvelope,
  getConsecutivePrimaryFailures,
} from '@/lib/marketData/resolver/marketDataResolver';
export type * from '@/lib/marketData/resolver/marketDataResolver';
export { getCandles as getHistoricalCandles } from '@/lib/marketData/getCandles';
export { resolveMarketCandles, fetchCandlesForSignalEngine } from '@/lib/marketData/resolveMarketCandles';
export { getMarketDataHealth as getProviderHealth } from '@/lib/marketData/marketDataHealth';
export { getMarketStatus, getMarketEnvelope, isMarketOpen } from '@/lib/marketData/marketHours';
export const MARKET_DATA_VERSION = {
  contractVersion: '1.0.0',
  implementation: 'quantorus365-market-data-resolver',
} as const;
export type * from '@contracts/market-data';
