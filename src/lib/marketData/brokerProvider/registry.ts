/**
 * Registry for broker-scoped market-data providers.
 *
 * Prefer this over reading MARKET_DATA_PROVIDER when the call is
 * tied to a user's selected data-source broker.
 */

import type { BrokerProviderName } from './types';
import type { BrokerMarketDataProvider } from './types';
import { isDataSourceBroker } from '@/lib/broker/connections/types';
import { zerodhaMarketDataProvider } from './zerodhaMarketDataProvider';
import { shoonyaMarketDataProvider } from './shoonyaMarketDataProvider';

const providers: Record<BrokerProviderName, BrokerMarketDataProvider> = {
  zerodha: zerodhaMarketDataProvider,
  shoonya: shoonyaMarketDataProvider,
};

export function getBrokerMarketDataProvider(
  broker: BrokerProviderName | string,
): BrokerMarketDataProvider {
  const key = String(broker).trim().toLowerCase();
  const normalized = key === 'kite' ? 'zerodha' : key;
  if (!isDataSourceBroker(normalized)) {
    throw new Error(`Unknown broker market-data provider: ${broker}`);
  }
  return providers[normalized];
}

export function listBrokerMarketDataProviders(): BrokerMarketDataProvider[] {
  return Object.values(providers);
}

export function assertBrokerMarketDataContract(
  provider: BrokerMarketDataProvider,
): void {
  const required: Array<keyof BrokerMarketDataProvider> = [
    'name',
    'connect',
    'disconnect',
    'isConnected',
    'subscribe',
    'unsubscribe',
    'fetchQuote',
    'fetchHistoricalCandles',
    'getStatus',
    'onTick',
  ];
  for (const key of required) {
    if (typeof (provider as unknown as Record<string, unknown>)[key] === 'undefined') {
      throw new Error(`BrokerMarketDataProvider missing capability: ${String(key)}`);
    }
  }
}
