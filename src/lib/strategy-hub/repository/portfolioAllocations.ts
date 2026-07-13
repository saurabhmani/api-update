// ════════════════════════════════════════════════════════════════
//  Strategy Hub — portfolio settings & allocations (Phase 8)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { AllocationMethod, AllocationHistoryRow, PortfolioSettings } from '../portfolio/types';
import { ensureStrategyHubTables } from './strategyHubSchema';

const DEFAULT_CAPITAL = Number(process.env.PAPER_INITIAL_CAPITAL ?? 1_000_000);

export async function loadPortfolioSettings(): Promise<PortfolioSettings> {
  await ensureStrategyHubTables();
  try {
    const { rows } = await db.query<{
      total_capital: number;
      currency: string;
      updated_by: string | null;
      updated_at: string;
    }>(
      `SELECT total_capital, currency, updated_by, updated_at
         FROM strategy_hub_portfolio_settings ORDER BY id DESC LIMIT 1`,
    );
    const row = rows?.[0];
    if (!row) {
      await db.query(
        `INSERT INTO strategy_hub_portfolio_settings (total_capital, currency) VALUES (?, 'INR')`,
        [DEFAULT_CAPITAL],
      );
      return {
        totalCapital: DEFAULT_CAPITAL,
        currency: 'INR',
        updatedAt: new Date().toISOString(),
        updatedBy: null,
      };
    }
    return {
      totalCapital: Number(row.total_capital),
      currency: String(row.currency),
      updatedAt: new Date(String(row.updated_at)).toISOString(),
      updatedBy: row.updated_by,
    };
  } catch {
    return {
      totalCapital: DEFAULT_CAPITAL,
      currency: 'INR',
      updatedAt: new Date().toISOString(),
      updatedBy: null,
    };
  }
}

export async function savePortfolioSettings(
  patch: { totalCapital?: number },
  actor: string,
): Promise<PortfolioSettings> {
  await ensureStrategyHubTables();
  const current = await loadPortfolioSettings();
  const totalCapital = patch.totalCapital ?? current.totalCapital;
  if (totalCapital < 0) throw new Error('Total capital cannot be negative.');

  const { rows } = await db.query<{ id: number }>(
    `SELECT id FROM strategy_hub_portfolio_settings ORDER BY id DESC LIMIT 1`,
  );
  if (rows?.[0]?.id) {
    await db.query(
      `UPDATE strategy_hub_portfolio_settings SET total_capital = ?, updated_by = ? WHERE id = ?`,
      [totalCapital, actor, rows[0].id],
    );
  } else {
    await db.query(
      `INSERT INTO strategy_hub_portfolio_settings (total_capital, updated_by) VALUES (?, ?)`,
      [totalCapital, actor],
    );
  }
  return loadPortfolioSettings();
}

export interface StoredAllocation {
  strategyId: string;
  allocationMethod: AllocationMethod;
  allocatedAmount: number;
  allocatedPct: number;
  isActive: boolean;
  updatedBy: string | null;
  updatedAt: string;
}

export async function loadAllAllocations(): Promise<Map<string, StoredAllocation>> {
  await ensureStrategyHubTables();
  const map = new Map<string, StoredAllocation>();
  try {
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT * FROM strategy_hub_capital_allocations`,
    );
    for (const r of rows ?? []) {
      map.set(String(r.strategy_id), {
        strategyId: String(r.strategy_id),
        allocationMethod: String(r.allocation_method) as AllocationMethod,
        allocatedAmount: Number(r.allocated_amount),
        allocatedPct: Number(r.allocated_pct),
        isActive: Boolean(Number(r.is_active)),
        updatedBy: r.updated_by ? String(r.updated_by) : null,
        updatedAt: new Date(String(r.updated_at)).toISOString(),
      });
    }
  } catch { /* table may not exist yet */ }
  return map;
}

export async function upsertAllocation(entry: {
  strategyId: string;
  method: AllocationMethod;
  amount: number;
  pct: number;
  isActive?: boolean;
  actor: string;
  reason?: string;
  fromAmount?: number;
  fromPct?: number;
}): Promise<void> {
  await ensureStrategyHubTables();
  const existing = (await loadAllAllocations()).get(entry.strategyId);

  await db.query(
    `INSERT INTO strategy_hub_capital_allocations
       (strategy_id, allocation_method, allocated_amount, allocated_pct, is_active, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       allocation_method = VALUES(allocation_method),
       allocated_amount = VALUES(allocated_amount),
       allocated_pct = VALUES(allocated_pct),
       is_active = VALUES(is_active),
       updated_by = VALUES(updated_by)`,
    [
      entry.strategyId,
      entry.method,
      entry.amount,
      entry.pct,
      entry.isActive !== false ? 1 : 0,
      entry.actor,
    ],
  );

  await db.query(
    `INSERT INTO strategy_hub_allocation_history
       (strategy_id, from_amount, to_amount, from_pct, to_pct, method, reason, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.strategyId,
      entry.fromAmount ?? existing?.allocatedAmount ?? 0,
      entry.amount,
      entry.fromPct ?? existing?.allocatedPct ?? 0,
      entry.pct,
      entry.method,
      entry.reason ?? null,
      entry.actor,
    ],
  );
}

export async function listAllocationHistory(opts: {
  strategyId?: string;
  limit?: number;
}): Promise<AllocationHistoryRow[]> {
  await ensureStrategyHubTables();
  const limit = Math.min(opts.limit ?? 50, 200);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.strategyId) {
    clauses.push('strategy_id = ?');
    params.push(opts.strategyId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM strategy_hub_allocation_history ${where} ORDER BY created_at DESC LIMIT ${limit}`,
    params,
  );
  return (rows ?? []).map((r) => ({
    id: Number(r.id),
    strategyId: String(r.strategy_id),
    strategyName: String(r.strategy_id).replace(/_/g, ' '),
    fromAmount: Number(r.from_amount),
    toAmount: Number(r.to_amount),
    fromPct: Number(r.from_pct),
    toPct: Number(r.to_pct),
    method: String(r.method) as AllocationMethod,
    reason: r.reason ? String(r.reason) : null,
    actor: r.actor ? String(r.actor) : null,
    createdAt: new Date(String(r.created_at)).toISOString(),
  }));
}
