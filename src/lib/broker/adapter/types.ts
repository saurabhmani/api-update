// Broker Adapter — abstract interface

import type {
  BrokerCredentials,
  BrokerHealthSnapshot,
  BrokerName,
  BrokerOrderSnapshot,
  BrokerPlaceOrderRequest,
  BrokerPlaceOrderResult,
  BrokerPositionSnapshot,
} from '../types';

export interface BrokerAdapter {
  readonly name: BrokerName;

  connect(credentials: BrokerCredentials): Promise<{ ok: boolean; error?: string }>;
  disconnect(): Promise<void>;
  refreshToken(credentials: BrokerCredentials): Promise<BrokerCredentials | null>;
  validateConnection(credentials: BrokerCredentials): Promise<{ ok: boolean; reason?: string }>;

  placeOrder(req: BrokerPlaceOrderRequest, credentials: BrokerCredentials): Promise<BrokerPlaceOrderResult>;
  cancelOrder(brokerOrderId: string, credentials: BrokerCredentials): Promise<{ ok: boolean; error?: string }>;
  getOrder(brokerOrderId: string, credentials: BrokerCredentials): Promise<BrokerOrderSnapshot | null>;
  listOrders(credentials: BrokerCredentials): Promise<BrokerOrderSnapshot[]>;
  listPositions(credentials: BrokerCredentials): Promise<BrokerPositionSnapshot[]>;

  healthCheck(credentials: BrokerCredentials): Promise<BrokerHealthSnapshot>;
}
