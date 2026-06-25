// Paper Trading Engine — wire types

export type PaperSide = 'BUY' | 'SELL';
export type PaperOrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT';
export type PaperOrderRole = 'ENTRY' | 'STOP' | 'TARGET' | 'EXIT';
export type PaperOrderStatus =
  | 'PENDING'
  | 'SUBMITTED'
  | 'PARTIAL'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED';

export type PaperPositionStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';

export interface PaperRiskConfig {
  virtualCapital: number;
  riskPerTradePct: number;
  maxDailyLossPct: number;
  maxOpenPositions: number;
  maxConsecutiveLosses: number;
  maxSymbolExposurePct: number;
  maxStrategyExposurePct: number;
  slippageBps: number;
  circuitBreakerDropPct: number;
  highVolatilityAtrPct: number;
}

export interface PaperAccount {
  id: string;
  userId: number;
  name: string;
  virtualCapital: number;
  cashBalance: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  risk: PaperRiskConfig;
  consecutiveLosses: number;
  dailyPnl: number;
  killSwitchActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaperOrder {
  id: string;
  accountId: string;
  symbol: string;
  side: PaperSide;
  orderType: PaperOrderType;
  role: PaperOrderRole;
  quantity: number;
  limitPrice?: number | null;
  stopPrice?: number | null;
  triggerPrice?: number | null;
  status: PaperOrderStatus;
  strategyId?: string | null;
  parentOrderId?: string | null;
  positionId?: string | null;
  filledQty: number;
  avgFillPrice?: number | null;
  rejectReason?: string | null;
  idempotencyKey?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaperPosition {
  id: string;
  accountId: string;
  symbol: string;
  side: PaperSide;
  quantity: number;
  entryPrice: number;
  currentPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  unrealizedPnl: number;
  realizedPnl?: number | null;
  status: PaperPositionStatus;
  strategyId?: string | null;
  entryOrderId?: string | null;
  exitOrderId?: string | null;
  exitReason?: string | null;
  openedAt: string;
  closedAt?: string | null;
  updatedAt: string;
}

export interface PaperFill {
  id: number;
  accountId: string;
  orderId: string;
  positionId?: string | null;
  symbol: string;
  side: PaperSide;
  quantity: number;
  fillPrice: number;
  slippageBps: number;
  fees: number;
  filledAt: string;
}

export interface PlaceOrderRequest {
  symbol: string;
  side: PaperSide;
  orderType?: PaperOrderType;
  role?: PaperOrderRole;
  quantity: number;
  limitPrice?: number;
  stopPrice?: number;
  triggerPrice?: number;
  strategyId?: string;
  stopLoss?: number;
  takeProfit?: number;
  idempotencyKey?: string;
  referencePrice?: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  code: string;
  message: string;
}

export interface SimulatedFillResult {
  filled: boolean;
  fillPrice: number;
  slippageBps: number;
  fees: number;
  reason?: string;
}

export interface PaperAccountSummary {
  account: PaperAccount;
  openPositions: PaperPosition[];
  closedPositions?: PaperPosition[];
  pendingOrders: PaperOrder[];
  recentFills: PaperFill[];
  mtm: {
    equity: number;
    cashBalance: number;
    unrealizedPnl: number;
    realizedPnl: number;
    dailyPnl: number;
    exposurePct: number;
  };
}

export interface TradeLog {
  id: number;
  accountId: string;
  userId: number;
  orderId?: string | null;
  positionId?: string | null;
  symbol: string;
  eventType: string;
  side?: string | null;
  quantity?: number | null;
  price?: number | null;
  pnl?: number | null;
  fees?: number | null;
  strategyId?: string | null;
  createdAt: string;
}

export interface RiskProfile {
  id: string;
  userId: number;
  accountId?: string | null;
  risk: PaperRiskConfig;
  killSwitchActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RiskEvent {
  id: number;
  userId: number;
  accountId?: string | null;
  eventType: string;
  code: string;
  message: string;
  symbol?: string | null;
  strategyId?: string | null;
  blocked: boolean;
  createdAt: string;
}

export const DEFAULT_PAPER_RISK: PaperRiskConfig = {
  virtualCapital: Number(process.env.PAPER_INITIAL_CAPITAL ?? 1_000_000),
  riskPerTradePct: Number(process.env.PAPER_RISK_PER_TRADE_PCT ?? 0.5),
  maxDailyLossPct: Number(process.env.PAPER_MAX_DAILY_LOSS_PCT ?? 2),
  maxOpenPositions: Number(process.env.PAPER_MAX_OPEN_POSITIONS ?? 5),
  maxConsecutiveLosses: Number(process.env.PAPER_MAX_CONSECUTIVE_LOSSES ?? 3),
  maxSymbolExposurePct: Number(process.env.PAPER_MAX_SYMBOL_EXPOSURE_PCT ?? 15),
  maxStrategyExposurePct: Number(process.env.PAPER_MAX_STRATEGY_EXPOSURE_PCT ?? 25),
  slippageBps: Number(process.env.PAPER_SLIPPAGE_BPS ?? 10),
  circuitBreakerDropPct: Number(process.env.PAPER_CIRCUIT_BREAKER_DROP_PCT ?? 5),
  highVolatilityAtrPct: Number(process.env.PAPER_HIGH_VOL_ATR_PCT ?? 6),
};
