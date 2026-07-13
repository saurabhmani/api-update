// ════════════════════════════════════════════════════════════════
//  Phase 7 — Research Paper Trading (no broker connectivity)
// ════════════════════════════════════════════════════════════════

import type { ResearchCandle, ResearchTrade } from '../types';
import { simulateFill, applySlippage } from '@/lib/paper-trading/orderSimulator';

export interface PaperPosition {
  symbol: string;
  quantity: number;
  avgPrice: number;
  stopLoss: number | null;
  target: number | null;
  openedAtBar: number;
}

export interface PaperPortfolio {
  cash: number;
  positions: PaperPosition[];
  realizedPnl: number;
  feesPaid: number;
}

export interface PaperTradeEvent {
  barIndex: number;
  type: 'entry' | 'partial_exit' | 'exit' | 'stop' | 'target';
  symbol: string;
  quantity: number;
  price: number;
  fees: number;
  reason: string;
}

export function createPaperPortfolio(initialCapital: number): PaperPortfolio {
  return { cash: initialCapital, positions: [], realizedPnl: 0, feesPaid: 0 };
}

export function simulatePaperEntry(input: {
  portfolio: PaperPortfolio;
  symbol: string;
  quantity: number;
  referencePrice: number;
  barIndex: number;
  stopLoss?: number;
  target?: number;
  slippageBps?: number;
  commission?: number;
}): { portfolio: PaperPortfolio; event: PaperTradeEvent | null } {
  const fill = simulateFill({
    side: 'BUY',
    orderType: 'MARKET',
    quantity: input.quantity,
    referencePrice: input.referencePrice,
    slippageBps: input.slippageBps ?? 10,
    commissionPerTrade: input.commission ?? 20,
  });
  if (!fill.filled) return { portfolio: input.portfolio, event: null };

  const cost = fill.fillPrice * input.quantity + fill.fees;
  if (cost > input.portfolio.cash) return { portfolio: input.portfolio, event: null };

  const position: PaperPosition = {
    symbol: input.symbol,
    quantity: input.quantity,
    avgPrice: fill.fillPrice,
    stopLoss: input.stopLoss ?? null,
    target: input.target ?? null,
    openedAtBar: input.barIndex,
  };

  return {
    portfolio: {
      ...input.portfolio,
      cash: input.portfolio.cash - cost,
      feesPaid: input.portfolio.feesPaid + fill.fees,
      positions: [...input.portfolio.positions, position],
    },
    event: {
      barIndex: input.barIndex,
      type: 'entry',
      symbol: input.symbol,
      quantity: input.quantity,
      price: fill.fillPrice,
      fees: fill.fees,
      reason: 'market_entry',
    },
  };
}

export function evolvePaperPortfolioOnBar(
  portfolio: PaperPortfolio,
  candle: ResearchCandle,
  barIndex: number,
  symbol: string,
  slippageBps = 10,
  commission = 20,
): { portfolio: PaperPortfolio; events: PaperTradeEvent[] } {
  const events: PaperTradeEvent[] = [];
  const remaining: PaperPosition[] = [];
  let cash = portfolio.cash;
  let realizedPnl = portfolio.realizedPnl;
  let feesPaid = portfolio.feesPaid;

  for (const pos of portfolio.positions) {
    if (pos.symbol !== symbol) {
      remaining.push(pos);
      continue;
    }

    if (pos.stopLoss != null && candle.low <= pos.stopLoss) {
      const exitPrice = applySlippage(pos.stopLoss, 'SELL', slippageBps);
      const proceeds = exitPrice * pos.quantity - commission;
      cash += proceeds;
      realizedPnl += (exitPrice - pos.avgPrice) * pos.quantity - commission;
      feesPaid += commission;
      events.push({ barIndex, type: 'stop', symbol, quantity: pos.quantity, price: exitPrice, fees: commission, reason: 'stop_hit' });
      continue;
    }

    if (pos.target != null && candle.high >= pos.target) {
      const half = Math.floor(pos.quantity / 2);
      if (half > 0) {
        const exitPrice = applySlippage(pos.target, 'SELL', slippageBps);
        const proceeds = exitPrice * half - commission;
        cash += proceeds;
        realizedPnl += (exitPrice - pos.avgPrice) * half - commission;
        feesPaid += commission;
        events.push({ barIndex, type: 'partial_exit', symbol, quantity: half, price: exitPrice, fees: commission, reason: 'target_partial' });
        remaining.push({ ...pos, quantity: pos.quantity - half });
      } else {
        const exitPrice = applySlippage(pos.target, 'SELL', slippageBps);
        cash += exitPrice * pos.quantity - commission;
        realizedPnl += (exitPrice - pos.avgPrice) * pos.quantity - commission;
        feesPaid += commission;
        events.push({ barIndex, type: 'target', symbol, quantity: pos.quantity, price: exitPrice, fees: commission, reason: 'target_hit' });
      }
      continue;
    }

    remaining.push(pos);
  }

  return {
    portfolio: { cash, positions: remaining, realizedPnl, feesPaid },
    events,
  };
}

export function paperTradesToResearchTrades(events: PaperTradeEvent[]): ResearchTrade[] {
  return events
    .filter((e) => e.type === 'exit' || e.type === 'stop' || e.type === 'target')
    .map((e) => ({
      symbol: e.symbol,
      strategyId: 'paper_research',
      entryPrice: 0,
      exitPrice: e.price,
      entryBar: 0,
      exitBar: e.barIndex,
      returnPct: 0,
      fees: e.fees,
      slippage: 0,
      exitReason: e.type === 'stop' ? 'stop' : 'target',
    }));
}
