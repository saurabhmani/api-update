// Broker Integration Layer — core types

export type BrokerName = 'simulated' | 'paper' | 'kite' | string;
export type BrokerConnectionStatus = 'connected' | 'disconnected' | 'expired' | 'error';
export type BrokerOrderStatus =
  | 'PENDING' | 'SUBMITTED' | 'OPEN' | 'PARTIAL' | 'FILLED'
  | 'CANCELLED' | 'REJECTED' | 'EXPIRED';

export interface BrokerCredentials {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  brokerUserId?: string;
  apiKey?: string;
  metadata?: Record<string, unknown>;
}

export interface BrokerPlaceOrderRequest {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType?: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  price?: number;
  triggerPrice?: number;
  product?: 'MIS' | 'CNC' | 'NRML';
  exchange?: 'NSE' | 'BSE';
  strategyId?: string;
  idempotencyKey?: string;
}

export interface BrokerPlaceOrderResult {
  ok: boolean;
  orderId?: string;
  brokerOrderId?: string;
  status?: BrokerOrderStatus;
  dryRun?: boolean;
  error?: string;
  errorCode?: string;
  raw?: unknown;
}

export interface BrokerOrderSnapshot {
  brokerOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  filledQty: number;
  price?: number;
  avgFillPrice?: number;
  status: BrokerOrderStatus;
  updatedAt?: string;
  raw?: unknown;
}

export interface BrokerPositionSnapshot {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  avgPrice: number;
  currentPrice?: number;
  unrealizedPnl?: number;
  status: 'OPEN' | 'CLOSED';
  raw?: unknown;
}

export interface BrokerHealthSnapshot {
  broker: BrokerName;
  status: 'healthy' | 'degraded' | 'down';
  latencyMs?: number;
  tokenValid: boolean;
  lastOrderAt?: string;
  errorRatePct?: number;
  message?: string;
  checkedAt: string;
}

export interface LiveTradingGateResult {
  allowed: boolean;
  gates: {
    backtest: { passed: boolean; message: string };
    paperHistory: { passed: boolean; message: string };
    riskValidation: { passed: boolean; message: string };
    disclaimer: { passed: boolean; message: string };
    killSwitch: { passed: boolean; message: string };
    brokerConnected: { passed: boolean; message: string };
  };
  issues: string[];
}

export const LIVE_DISCLAIMER_VERSION = '1.0';
export const MIN_PAPER_TRADES_FOR_LIVE = Number(process.env.LIVE_MIN_PAPER_TRADES ?? 5);
