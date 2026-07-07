// Risk Engine — pre-trade and portfolio-level gates

import type {
  PaperAccount,
  PaperOrder,
  PaperPosition,
  PaperRiskConfig,
  PlaceOrderRequest,
  RiskCheckResult,
} from './types';
import { computePositionNotional } from './orderSimulator';

function deny(code: string, message: string): RiskCheckResult {
  return { allowed: false, code, message };
}

function allow(): RiskCheckResult {
  return { allowed: true, code: 'OK', message: 'Risk checks passed' };
}

export interface RiskContext {
  account: PaperAccount;
  openPositions: PaperPosition[];
  pendingOrders: PaperOrder[];
  priorClosePrice?: number | null;
  atrPct?: number | null;
  todayOrderCount?: number;
  killSwitchActive: boolean;
  marketOpen: boolean;
}

export function evaluateOrderRisk(
  req: PlaceOrderRequest,
  ctx: RiskContext,
): RiskCheckResult {
  const { account, openPositions, pendingOrders } = ctx;
  const risk = account.risk;

  if (ctx.killSwitchActive || account.killSwitchActive) {
    return deny('KILL_SWITCH', 'Trading halted by kill switch');
  }

  if (!ctx.marketOpen && (req.orderType ?? 'MARKET') === 'MARKET') {
    return deny('MARKET_CLOSED', 'Market orders blocked when exchange is closed');
  }

  if (req.idempotencyKey) {
    const dup = pendingOrders.some((o) => o.idempotencyKey === req.idempotencyKey);
    if (dup) return deny('DUPLICATE_ORDER', 'Duplicate idempotency key');
  }

  const symbol = req.symbol.toUpperCase();
  const hasOpen = openPositions.some((p) => p.symbol === symbol && p.status === 'OPEN');
  const hasPendingEntry = pendingOrders.some(
    (o) => o.symbol === symbol && o.role === 'ENTRY' && ['PENDING', 'SUBMITTED'].includes(o.status),
  );
  if ((req.role ?? 'ENTRY') === 'ENTRY' && (hasOpen || hasPendingEntry)) {
    return deny('DUPLICATE_SYMBOL', `Already have exposure in ${symbol}`);
  }

  if ((req.role ?? 'ENTRY') === 'ENTRY' && openPositions.length >= risk.maxOpenPositions) {
    return deny('MAX_POSITIONS', `Max open positions (${risk.maxOpenPositions}) reached`);
  }

  if ((req.role ?? 'ENTRY') === 'ENTRY' && (ctx.todayOrderCount ?? 0) >= risk.maxTradesPerDay) {
    return deny('MAX_TRADES_PER_DAY', `Max trades per day (${risk.maxTradesPerDay}) reached`);
  }

  if (account.consecutiveLosses >= risk.maxConsecutiveLosses) {
    return deny('CONSECUTIVE_LOSSES', `Consecutive loss limit (${risk.maxConsecutiveLosses}) reached`);
  }

  const maxDailyLoss = account.virtualCapital * (risk.maxDailyLossPct / 100);
  if (account.dailyPnl <= -maxDailyLoss) {
    return deny('MAX_DAILY_LOSS', `Daily loss limit (${risk.maxDailyLossPct}%) breached`);
  }

  const refPrice = req.referencePrice ?? req.limitPrice ?? 0;
  if (refPrice > 0) {
    const notional = computePositionNotional(req.quantity, refPrice);
    const symbolExposure = openPositions
      .filter((p) => p.symbol === symbol)
      .reduce((s, p) => s + computePositionNotional(p.quantity, p.currentPrice ?? p.entryPrice), notional);
    const symbolPct = (symbolExposure / account.equity) * 100;
    if (symbolPct > risk.maxSymbolExposurePct) {
      return deny('SYMBOL_EXPOSURE', `Symbol exposure ${symbolPct.toFixed(1)}% exceeds ${risk.maxSymbolExposurePct}%`);
    }

    if (req.strategyId) {
      const stratExposure = openPositions
        .filter((p) => p.strategyId === req.strategyId)
        .reduce((s, p) => s + computePositionNotional(p.quantity, p.currentPrice ?? p.entryPrice), notional);
      const stratPct = (stratExposure / account.equity) * 100;
      if (stratPct > risk.maxStrategyExposurePct) {
        return deny('STRATEGY_EXPOSURE', `Strategy exposure ${stratPct.toFixed(1)}% exceeds ${risk.maxStrategyExposurePct}%`);
      }
    }

    const riskBudget = account.equity * (risk.riskPerTradePct / 100);
    const impliedRisk = req.stopLoss && refPrice
      ? Math.abs(refPrice - req.stopLoss) * req.quantity
      : notional * 0.02;
    if (impliedRisk > riskBudget * 1.5) {
      return deny('RISK_PER_TRADE', `Implied risk ₹${impliedRisk.toFixed(0)} exceeds budget ₹${riskBudget.toFixed(0)}`);
    }
  }

  if (ctx.priorClosePrice && refPrice > 0) {
    const dropPct = ((ctx.priorClosePrice - refPrice) / ctx.priorClosePrice) * 100;
    if (req.side === 'BUY' && dropPct >= risk.circuitBreakerDropPct) {
      return deny('CIRCUIT_BREAKER', `Circuit breaker: ${symbol} down ${dropPct.toFixed(1)}%`);
    }
  }

  if (ctx.atrPct != null && ctx.atrPct >= risk.highVolatilityAtrPct) {
    return deny('HIGH_VOLATILITY', `ATR ${ctx.atrPct.toFixed(1)}% exceeds ${risk.highVolatilityAtrPct}% threshold`);
  }

  if (notionalExceedsCash(req, refPrice, account.cashBalance, req.side)) {
    return deny('INSUFFICIENT_CASH', 'Insufficient virtual cash for order');
  }

  return allow();
}

function notionalExceedsCash(
  req: PlaceOrderRequest,
  price: number,
  cash: number,
  side: string,
): boolean {
  if (side === 'SELL' || price <= 0) return false;
  return computePositionNotional(req.quantity, price) > cash;
}

export function sizingFromRisk(
  equity: number,
  entryPrice: number,
  stopLoss: number,
  risk: PaperRiskConfig,
): number {
  const riskAmount = equity * (risk.riskPerTradePct / 100);
  const perShareRisk = Math.abs(entryPrice - stopLoss);
  if (perShareRisk <= 0) return 0;
  return Math.max(1, Math.floor(riskAmount / perShareRisk));
}
