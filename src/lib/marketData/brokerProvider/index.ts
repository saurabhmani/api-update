/**
 * Broker-neutral market-data providers (Zerodha / Shoonya).
 *
 * @example
 *   const provider = getBrokerMarketDataProvider('shoonya');
 *   await provider.subscribe({ userId }, [{ symbol: 'RELIANCE', exchange: 'NSE' }]);
 *   // instrumentKey is derived: NSE_EQ|RELIANCE
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
  getBrokerMarketDataProvider,
  listBrokerMarketDataProviders,
  assertBrokerMarketDataContract,
} from './registry';

export { zerodhaMarketDataProvider, ZerodhaMarketDataProvider } from './zerodhaMarketDataProvider';
export { shoonyaMarketDataProvider, ShoonyaMarketDataProvider } from './shoonyaMarketDataProvider';
export {
  toInstrumentKey,
  instrumentKeyFromNormalized,
  toKiteInstrumentKey,
  toShoonyaScripKey,
  normalizeInstrument,
  parseInstrumentKey,
  mapToZerodhaInstrument,
  mapToShoonyaInstrument,
  mapManyToZerodha,
  mapManyToShoonya,
  getSubscriptionBook,
  clearSubscriptionBook,
} from './instruments';
