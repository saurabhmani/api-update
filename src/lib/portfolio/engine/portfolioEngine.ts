// ════════════════════════════════════════════════════════════════
//  Phase 8 — Portfolio Engine
//  Tracks positions, cash, allocations, PnL, buying power.
// ════════════════════════════════════════════════════════════════

import type { PortfolioRecord, PortfolioPosition } from '../types';
import { getSector } from '@/lib/signal-engine/constants/phase3.constants';

export interface PortfolioSnapshot {
  capital: number;
  cash: number;
  realizedPnl: number;
  unrealizedPnl: number;
  availableBuyingPower: number;
  grossExposure: number;
  netExposure: number;
  positions: PortfolioPosition[];
  allocations: Record<string, number>;
  sectorAllocations: Record<string, number>;
}

export function buildPortfolioSnapshot(portfolio: PortfolioRecord): PortfolioSnapshot {
  const sectorAllocations: Record<string, number> = {};
  let grossExposure = 0;
  let netExposure = 0;

  for (const pos of portfolio.positions) {
    grossExposure += Math.abs(pos.marketValue);
    netExposure += pos.direction === 'long' ? pos.marketValue : -pos.marketValue;
    sectorAllocations[pos.sector] = (sectorAllocations[pos.sector] ?? 0) + Math.abs(pos.marketValue);
  }

  if (portfolio.capital > 0) {
    for (const k of Object.keys(sectorAllocations)) {
      sectorAllocations[k] = Math.round((sectorAllocations[k] / portfolio.capital) * 10000) / 10000;
    }
  }

  return {
    capital: portfolio.capital,
    cash: portfolio.cash,
    realizedPnl: portfolio.realizedPnl,
    unrealizedPnl: portfolio.unrealizedPnl,
    availableBuyingPower: portfolio.availableBuyingPower,
    grossExposure,
    netExposure,
    positions: portfolio.positions,
    allocations: portfolio.allocations,
    sectorAllocations,
  };
}

export function createPosition(input: {
  symbol: string;
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  direction: 'long' | 'short';
  country?: string;
  currency?: string;
}): PortfolioPosition {
  const marketValue = input.quantity * input.currentPrice;
  const unrealizedPnl = input.direction === 'long'
    ? (input.currentPrice - input.avgPrice) * input.quantity
    : (input.avgPrice - input.currentPrice) * input.quantity;

  return {
    symbol: input.symbol,
    sector: getSector(input.symbol),
    country: input.country ?? 'IN',
    currency: input.currency ?? 'INR',
    quantity: input.quantity,
    avgPrice: input.avgPrice,
    marketValue,
    direction: input.direction,
    unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
    weight: 0,
  };
}

export function markPositionsToMarket(
  positions: PortfolioPosition[],
  prices: Record<string, number>,
  capital: number,
): PortfolioPosition[] {
  return positions.map((p) => {
    const price = prices[p.symbol] ?? p.avgPrice;
    const marketValue = p.quantity * price;
    const unrealizedPnl = p.direction === 'long'
      ? (price - p.avgPrice) * p.quantity
      : (p.avgPrice - price) * p.quantity;
    return {
      ...p,
      marketValue,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      weight: capital > 0 ? Math.round((Math.abs(marketValue) / capital) * 10000) / 10000 : 0,
    };
  });
}

export function computeBuyingPower(cash: number, grossExposure: number, maxGrossPct: number, capital: number): number {
  const maxGross = capital * (maxGrossPct / 100);
  const headroom = Math.max(0, maxGross - grossExposure);
  return Math.min(cash, headroom);
}
