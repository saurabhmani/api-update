// Position Manager — open/close lifecycle + MTM

import { v4 as uuidv4 } from 'uuid';
import type { PaperAccount, PaperOrder, PaperPosition, PaperSide } from './types';
import {
  checkExitTriggers,
  computePositionNotional,
  computeUnrealizedPnl,
} from './orderSimulator';

export function createOpenPosition(input: {
  accountId: string;
  symbol: string;
  side: PaperSide;
  quantity: number;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
  strategyId?: string;
  entryOrderId: string;
}): PaperPosition {
  const now = new Date().toISOString();
  return {
    id: `pos_${uuidv4().slice(0, 12)}`,
    accountId: input.accountId,
    symbol: input.symbol,
    side: input.side,
    quantity: input.quantity,
    entryPrice: input.entryPrice,
    currentPrice: input.entryPrice,
    stopLoss: input.stopLoss ?? null,
    takeProfit: input.takeProfit ?? null,
    unrealizedPnl: 0,
    status: 'OPEN',
    strategyId: input.strategyId ?? null,
    entryOrderId: input.entryOrderId,
    openedAt: now,
    updatedAt: now,
  };
}

export function markPositionMtm(
  position: PaperPosition,
  markPrice: number,
): PaperPosition {
  const unrealizedPnl = computeUnrealizedPnl(
    position.side,
    position.quantity,
    position.entryPrice,
    markPrice,
  );
  return {
    ...position,
    currentPrice: markPrice,
    unrealizedPnl,
    updatedAt: new Date().toISOString(),
  };
}

export function closePositionAtPrice(
  position: PaperPosition,
  exitPrice: number,
  reason: string,
  exitOrderId?: string,
): PaperPosition {
  const realizedPnl = computeUnrealizedPnl(
    position.side,
    position.quantity,
    position.entryPrice,
    exitPrice,
  );
  return {
    ...position,
    currentPrice: exitPrice,
    unrealizedPnl: 0,
    realizedPnl: realizedPnl,
    status: 'CLOSED',
    exitReason: reason,
    exitOrderId: exitOrderId ?? null,
    closedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export interface MtmResult {
  positions: PaperPosition[];
  totalUnrealized: number;
  equity: number;
  exits: Array<{ position: PaperPosition; reason: string; exitPrice: number }>;
}

export function runMtmPass(
  account: PaperAccount,
  positions: PaperPosition[],
  prices: Record<string, number>,
): MtmResult {
  const exits: MtmResult['exits'] = [];
  let totalUnrealized = 0;
  const updated: PaperPosition[] = [];

  for (const pos of positions) {
    const mark = prices[pos.symbol] ?? pos.currentPrice ?? pos.entryPrice;
    let current = markPositionMtm(pos, mark);
    totalUnrealized += current.unrealizedPnl;

    const trigger = checkExitTriggers(pos.side, mark, pos.stopLoss, pos.takeProfit);
    if (trigger.exit && trigger.reason && trigger.exitPrice != null) {
      exits.push({ position: pos, reason: trigger.reason, exitPrice: trigger.exitPrice });
    } else {
      updated.push(current);
    }
  }

  const holdingsValue = updated.reduce(
    (s, p) => s + computePositionNotional(p.quantity, p.currentPrice ?? p.entryPrice),
    0,
  );
  const computedEquity = account.cashBalance + holdingsValue;

  return {
    positions: updated,
    totalUnrealized,
    equity: Math.round(computedEquity * 100) / 100,
    exits,
  };
}

export function applyFillToCash(
  cash: number,
  side: PaperSide,
  quantity: number,
  fillPrice: number,
  fees: number,
): number {
  const notional = computePositionNotional(quantity, fillPrice);
  if (side === 'BUY') return cash - notional - fees;
  return cash + notional - fees;
}

export function pendingOrdersForBook(orders: PaperOrder[]): PaperOrder[] {
  return orders.filter((o) => ['PENDING', 'SUBMITTED', 'PARTIAL'].includes(o.status));
}
