// OAuth-oriented broker adapters for data-source login

import type { BrokerConnectionRecord } from '../connections/types';
import type { DataSourceBroker } from '../connections/types';

export interface BrokerConnectionResult {
  ok: boolean;
  broker: DataSourceBroker;
  connection?: BrokerConnectionRecord;
  error?: string;
  errorCode?: string;
}

export interface DataSourceBrokerAdapter {
  readonly name: DataSourceBroker;
  getAuthorizationUrl(userId: number): Promise<string>;
  handleCallback(
    userId: number,
    params: Record<string, string | null>,
  ): Promise<BrokerConnectionResult>;
  validateConnection(connection: BrokerConnectionRecord): Promise<boolean>;
  disconnect(connection: BrokerConnectionRecord): Promise<void>;
}
