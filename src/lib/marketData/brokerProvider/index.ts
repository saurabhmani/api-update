/**
 * Minimal broker-neutral instrument helpers.
 * Zerodha/Shoonya market-data providers have been removed (IndianAPI-only).
 */

export type {
  BrokerProviderName,
  BrokerConnectionContext,
  NormalizedInstrument,
  NormalizedInstrumentInput,
  NormalizedQuote,
  NormalizedCandle,
  NormalizedTick,
  NormalizedTickHandler,
  BrokerCandleInterval,
  HistoricalCandleRequest,
  ProviderConnectionState,
  ProviderConnectionStatus,
  BrokerSession,
  BrokerMarketDataProvider,
  BrokerMarketDataErrorCode,
} from './types';

export { BrokerMarketDataError } from './types';

export {
  toInstrumentKey,
  instrumentKeyFromNormalized,
  normalizeInstrument,
  parseInstrumentKey,
} from './instruments/normalize';

/** @deprecated Broker MD providers removed — always throws. */
export function getBrokerMarketDataProvider(
  _name: string,
): never {
  throw new Error(
    'Broker market-data providers (Zerodha/Shoonya) have been removed. '
    + 'Use IndianAPI warehouse via MarketDataProvider.',
  );
}

/** @deprecated Empty — no broker MD providers registered. */
export function listBrokerMarketDataProviders(): [] {
  return [];
}

export function assertBrokerMarketDataContract(): void {
  // no-op — providers removed
}
