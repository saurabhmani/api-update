// ════════════════════════════════════════════════════════════════
//  Phase 8 — Portfolio Registry
// ════════════════════════════════════════════════════════════════

import type { PortfolioRecord, PortfolioPosition } from '../types';
import { PORTFOLIO_SCHEMA_VERSION } from '../types';

let counter = 0;
const registry = new Map<string, PortfolioRecord>();

export function createPortfolioId(owner: string): string {
  counter += 1;
  const slug = owner.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toLowerCase() || 'user';
  return `pf_${slug}_${counter}`;
}

export function registerPortfolio(input: {
  name: string;
  owner: string;
  capital: number;
  cash?: number;
  positions?: PortfolioPosition[];
  createdAt?: string;
}): PortfolioRecord {
  if (!input.owner?.trim()) throw new Error('Portfolio owner is required');
  const capital = input.capital;
  const cash = input.cash ?? capital;
  const positions = input.positions ?? [];
  const unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const invested = positions.reduce((s, p) => s + Math.abs(p.marketValue), 0);

  const record: PortfolioRecord = {
    portfolioId: createPortfolioId(input.owner),
    name: input.name,
    owner: input.owner.trim(),
    status: 'active',
    capital,
    cash,
    realizedPnl: 0,
    unrealizedPnl,
    availableBuyingPower: Math.max(0, cash),
    positions,
    allocations: computeAllocations(positions, capital),
    createdAt: input.createdAt ?? new Date().toISOString(),
    version: PORTFOLIO_SCHEMA_VERSION,
  };

  registry.set(record.portfolioId, Object.freeze({ ...record }));
  return record;
}

function computeAllocations(positions: PortfolioPosition[], capital: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (capital <= 0) return out;
  for (const p of positions) {
    out[p.symbol] = Math.round((Math.abs(p.marketValue) / capital) * 10000) / 10000;
  }
  return out;
}

export function getPortfolio(portfolioId: string): PortfolioRecord | null {
  return registry.get(portfolioId) ?? null;
}

export function updatePortfolio(
  portfolioId: string,
  patch: Partial<Pick<PortfolioRecord, 'positions' | 'cash' | 'realizedPnl' | 'status'>>,
): PortfolioRecord {
  const existing = registry.get(portfolioId);
  if (!existing) throw new Error(`Portfolio not found: ${portfolioId}`);
  const positions = patch.positions ?? existing.positions;
  const unrealizedPnl = positions.reduce((s, p) => s + p.unrealizedPnl, 0);
  const cash = patch.cash ?? existing.cash;
  const merged: PortfolioRecord = {
    ...existing,
    ...patch,
    positions,
    unrealizedPnl,
    availableBuyingPower: Math.max(0, cash),
    allocations: computeAllocations(positions, existing.capital),
  };
  registry.set(portfolioId, Object.freeze(merged));
  return merged;
}

export function listPortfolios(owner?: string): PortfolioRecord[] {
  const rows = [...registry.values()];
  return owner ? rows.filter((r) => r.owner === owner) : rows;
}

export function clearPortfolioRegistry(): void {
  registry.clear();
  counter = 0;
}
