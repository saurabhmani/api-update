// Order Simulator — deterministic paper fills with slippage

import type { PaperOrderType, PaperSide, SimulatedFillResult } from './types';

export interface SimulateFillInput {
  side: PaperSide;
  orderType: PaperOrderType;
  quantity: number;
  referencePrice: number;
  limitPrice?: number | null;
  stopPrice?: number | null;
  slippageBps?: number;
  commissionPerTrade?: number;
}

export function applySlippage(price: number, side: PaperSide, slippageBps: number): number {
  const factor = slippageBps / 10_000;
  const adjusted = side === 'BUY' ? price * (1 + factor) : price * (1 - factor);
  return Math.round(adjusted * 100) / 100;
}

export function simulateFill(input: SimulateFillInput): SimulatedFillResult {
  const slippageBps = input.slippageBps ?? 10;
  const commission = input.commissionPerTrade ?? 20;
  const ref = input.referencePrice;
  if (!Number.isFinite(ref) || ref <= 0) {
    return { filled: false, fillPrice: 0, slippageBps: 0, fees: 0, reason: 'Invalid reference price' };
  }

  switch (input.orderType) {
    case 'MARKET': {
      const fillPrice = applySlippage(ref, input.side, slippageBps);
      return { filled: true, fillPrice, slippageBps, fees: commission };
    }
    case 'LIMIT': {
      if (input.limitPrice == null) {
        return { filled: false, fillPrice: 0, slippageBps: 0, fees: 0, reason: 'Limit price required' };
      }
      const canFill =
        input.side === 'BUY' ? ref <= input.limitPrice : ref >= input.limitPrice;
      if (!canFill) {
        return { filled: false, fillPrice: 0, slippageBps: 0, fees: 0, reason: 'Limit not reached' };
      }
      const fillPrice = input.side === 'BUY'
        ? Math.min(ref, input.limitPrice)
        : Math.max(ref, input.limitPrice);
      return { filled: true, fillPrice, slippageBps: 0, fees: commission };
    }
    case 'STOP':
    case 'STOP_LIMIT': {
      if (input.stopPrice == null) {
        return { filled: false, fillPrice: 0, slippageBps: 0, fees: 0, reason: 'Stop price required' };
      }
      const triggered =
        input.side === 'BUY' ? ref >= input.stopPrice : ref <= input.stopPrice;
      if (!triggered) {
        return { filled: false, fillPrice: 0, slippageBps: 0, fees: 0, reason: 'Stop not triggered' };
      }
      const fillPrice = applySlippage(ref, input.side, slippageBps);
      return { filled: true, fillPrice, slippageBps, fees: commission };
    }
    default:
      return { filled: false, fillPrice: 0, slippageBps: 0, fees: 0, reason: 'Unsupported order type' };
  }
}

/** Check SL/TP exit on a position against current mark price. */
export function checkExitTriggers(
  side: PaperSide,
  markPrice: number,
  stopLoss?: number | null,
  takeProfit?: number | null,
): { exit: boolean; reason?: 'STOP_LOSS' | 'TAKE_PROFIT'; exitPrice?: number } {
  if (side === 'BUY') {
    if (stopLoss != null && markPrice <= stopLoss) {
      return { exit: true, reason: 'STOP_LOSS', exitPrice: stopLoss };
    }
    if (takeProfit != null && markPrice >= takeProfit) {
      return { exit: true, reason: 'TAKE_PROFIT', exitPrice: takeProfit };
    }
  } else {
    if (stopLoss != null && markPrice >= stopLoss) {
      return { exit: true, reason: 'STOP_LOSS', exitPrice: stopLoss };
    }
    if (takeProfit != null && markPrice <= takeProfit) {
      return { exit: true, reason: 'TAKE_PROFIT', exitPrice: takeProfit };
    }
  }
  return { exit: false };
}

export function computeUnrealizedPnl(
  side: PaperSide,
  quantity: number,
  entryPrice: number,
  markPrice: number,
): number {
  const pnl = side === 'BUY'
    ? (markPrice - entryPrice) * quantity
    : (entryPrice - markPrice) * quantity;
  return Math.round(pnl * 100) / 100;
}

export function computePositionNotional(quantity: number, price: number): number {
  return quantity * price;
}
