// Simulated Broker Adapter — dry-run live orders without real broker I/O

import { v4 as uuidv4 } from 'uuid';
import type { BrokerAdapter } from './types';
import type {
  BrokerCredentials,
  BrokerHealthSnapshot,
  BrokerOrderSnapshot,
  BrokerPlaceOrderRequest,
  BrokerPlaceOrderResult,
  BrokerPositionSnapshot,
} from '../types';

const orders = new Map<string, BrokerOrderSnapshot>();
const positions = new Map<string, BrokerPositionSnapshot>();

export class SimulatedBrokerAdapter implements BrokerAdapter {
  readonly name = 'simulated' as const;

  async connect(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async disconnect(): Promise<void> { /* noop */ }

  async refreshToken(credentials: BrokerCredentials): Promise<BrokerCredentials | null> {
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return { ...credentials, expiresAt: expires };
  }

  async validateConnection(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async placeOrder(req: BrokerPlaceOrderRequest): Promise<BrokerPlaceOrderResult> {
    const id = `sim_${uuidv4().slice(0, 12)}`;
    const fillPrice = req.price ?? 100;
    orders.set(id, {
      brokerOrderId: id,
      symbol: req.symbol.toUpperCase(),
      side: req.side,
      quantity: req.quantity,
      filledQty: req.quantity,
      price: req.price,
      avgFillPrice: fillPrice,
      status: 'FILLED',
      updatedAt: new Date().toISOString(),
    });
    if (req.side === 'BUY') {
      positions.set(req.symbol.toUpperCase(), {
        symbol: req.symbol.toUpperCase(),
        side: 'BUY',
        quantity: req.quantity,
        avgPrice: fillPrice,
        currentPrice: fillPrice,
        unrealizedPnl: 0,
        status: 'OPEN',
      });
    }
    return { ok: true, orderId: id, brokerOrderId: id, status: 'FILLED', dryRun: true };
  }

  async cancelOrder(brokerOrderId: string): Promise<{ ok: boolean }> {
    const o = orders.get(brokerOrderId);
    if (o) orders.set(brokerOrderId, { ...o, status: 'CANCELLED' });
    return { ok: true };
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderSnapshot | null> {
    return orders.get(brokerOrderId) ?? null;
  }

  async listOrders(): Promise<BrokerOrderSnapshot[]> {
    return Array.from(orders.values());
  }

  async listPositions(): Promise<BrokerPositionSnapshot[]> {
    return Array.from(positions.values()).filter((p) => p.status === 'OPEN');
  }

  async healthCheck(): Promise<BrokerHealthSnapshot> {
    return {
      broker: 'simulated',
      status: 'healthy',
      latencyMs: 5,
      tokenValid: true,
      checkedAt: new Date().toISOString(),
    };
  }
}

export const simulatedAdapter = new SimulatedBrokerAdapter();
