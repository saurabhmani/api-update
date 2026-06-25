// Paper Broker Adapter — delegates to paper trading engine

import type { BrokerAdapter } from './types';
import type {
  BrokerCredentials,
  BrokerHealthSnapshot,
  BrokerOrderSnapshot,
  BrokerPlaceOrderRequest,
  BrokerPlaceOrderResult,
  BrokerPositionSnapshot,
} from '../types';

export class PaperBrokerAdapter implements BrokerAdapter {
  readonly name = 'paper' as const;
  private userId = 0;

  setUserId(userId: number): void {
    this.userId = userId;
  }

  async connect(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async disconnect(): Promise<void> { /* noop */ }

  async refreshToken(credentials: BrokerCredentials): Promise<BrokerCredentials | null> {
    return credentials;
  }

  async validateConnection(): Promise<{ ok: boolean }> {
    return { ok: this.userId > 0 };
  }

  async placeOrder(req: BrokerPlaceOrderRequest): Promise<BrokerPlaceOrderResult> {
    if (!this.userId) return { ok: false, error: 'Paper adapter requires userId', errorCode: 'NO_USER' };
    const { placePaperOrder } = await import('@/lib/paper-trading');
    const result = await placePaperOrder(this.userId, {
      symbol: req.symbol,
      side: req.side,
      quantity: req.quantity,
      orderType: req.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
      limitPrice: req.price,
      strategyId: req.strategyId,
      idempotencyKey: req.idempotencyKey,
      referencePrice: req.price,
    });
    return {
      ok: result.ok,
      orderId: result.order?.id,
      brokerOrderId: result.order?.id,
      status: result.order?.status as BrokerPlaceOrderResult['status'],
      error: result.error,
      errorCode: result.code,
    };
  }

  async cancelOrder(): Promise<{ ok: boolean; error?: string }> {
    return { ok: false, error: 'Paper cancel not implemented' };
  }

  async getOrder(brokerOrderId: string): Promise<BrokerOrderSnapshot | null> {
    const { listOrders, findAccountByUser } = await import('@/lib/paper-trading/repository/paperTradingRepository');
    const acct = await findAccountByUser(this.userId);
    if (!acct) return null;
    const orders = await listOrders(acct.id);
    const o = orders.find((x) => x.id === brokerOrderId);
    if (!o) return null;
    return {
      brokerOrderId: o.id,
      symbol: o.symbol,
      side: o.side,
      quantity: o.quantity,
      filledQty: o.filledQty,
      price: o.limitPrice ?? undefined,
      avgFillPrice: o.avgFillPrice ?? undefined,
      status: o.status as BrokerOrderSnapshot['status'],
      updatedAt: o.updatedAt,
    };
  }

  async listOrders(): Promise<BrokerOrderSnapshot[]> {
    const { listOrders, findAccountByUser } = await import('@/lib/paper-trading/repository/paperTradingRepository');
    const acct = await findAccountByUser(this.userId);
    if (!acct) return [];
    const orders = await listOrders(acct.id);
    return orders.map((o) => ({
      brokerOrderId: o.id,
      symbol: o.symbol,
      side: o.side,
      quantity: o.quantity,
      filledQty: o.filledQty,
      price: o.limitPrice ?? undefined,
      avgFillPrice: o.avgFillPrice ?? undefined,
      status: o.status as BrokerOrderSnapshot['status'],
      updatedAt: o.updatedAt,
    }));
  }

  async listPositions(): Promise<BrokerPositionSnapshot[]> {
    const { listOpenPositions, findAccountByUser } = await import('@/lib/paper-trading/repository/paperTradingRepository');
    const acct = await findAccountByUser(this.userId);
    if (!acct) return [];
    const positions = await listOpenPositions(acct.id);
    return positions.map((p) => ({
      symbol: p.symbol,
      side: p.side,
      quantity: p.quantity,
      avgPrice: p.entryPrice,
      currentPrice: p.currentPrice ?? undefined,
      unrealizedPnl: p.unrealizedPnl,
      status: p.status === 'OPEN' ? 'OPEN' : 'CLOSED',
    }));
  }

  async healthCheck(): Promise<BrokerHealthSnapshot> {
    return {
      broker: 'paper',
      status: 'healthy',
      latencyMs: 10,
      tokenValid: true,
      checkedAt: new Date().toISOString(),
    };
  }
}

export const paperAdapter = new PaperBrokerAdapter();
