import { shoonyaBrokerAdapter } from './shoonyaAdapter';
import { zerodhaBrokerAdapter } from './zerodhaAdapter';
import type { DataSourceBroker } from '../connections/types';
import type { DataSourceBrokerAdapter } from './types';

const adapters: Record<DataSourceBroker, DataSourceBrokerAdapter> = {
  zerodha: zerodhaBrokerAdapter,
  shoonya: shoonyaBrokerAdapter,
};

export function getDataSourceBrokerAdapter(
  broker: DataSourceBroker,
): DataSourceBrokerAdapter {
  return adapters[broker];
}

export { zerodhaBrokerAdapter, shoonyaBrokerAdapter };
export type { DataSourceBrokerAdapter, BrokerConnectionResult } from './types';
