// ════════════════════════════════════════════════════════════════
//  Portfolio Ledger & State Engine — Phase 2
//
//  Deterministically reconstruct holdings, value, cost basis, P&L,
//  and portfolio-level snapshot as-of any given time.
//
//  Sub-services:
//    - portfolioLedgerService  (this file)
//    - pnlService              (P&L computation)
//    - holdingsAggregationService (roll-up)
//    - valuationService        (NAV / market value)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import {
  CanonicalPosition,
  CanonicalTransaction,
  toCanonicalPosition,
  toCanonicalTransaction,
} from '@/types/canonical';

const log = logger.child({ service: 'portfolioLedger' });

// ── Types ───────────────────────────────────────────────────────

export interface HoldingRow {
  ticker: string;
  instrumentId: number;
  quantity: number;
  avgCost: number;
  marketPrice: number;
  marketValue: number;
  investedValue: number;
  weight: number;          // % of portfolio
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  sector: string | null;
}

export interface PnlSummary {
  totalInvested: number;
  currentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  realizedPnl: number;
  totalPnl: number;
  totalPnlPct: number;
}

export interface PortfolioOverview {
  portfolioId: number;
  portfolioName: string;
  ownerType: string;
  baseCurrency: string;
  benchmark: string | null;
  holdings: HoldingRow[];
  pnl: PnlSummary;
  positionsCount: number;
  cashBalance: number;
  totalAum: number;
  asOf: string;
}

export interface PortfolioSnapshot {
  portfolioId: number;
  date: string;
  totalValue: number;
  investedValue: number;
  pnl: number;
  pnlPct: number;
  positionsCount: number;
}

// ── Holdings Aggregation Service ────────────────────────────────

export async function getHoldings(portfolioId: number): Promise<HoldingRow[]> {
  const { rows } = await db.query(
    `SELECT pp.*, i.sector, i.id AS resolved_instrument_id
     FROM portfolio_positions pp
     LEFT JOIN instruments i ON pp.instrument_id = i.id
     WHERE pp.portfolio_id = ? AND pp.quantity > 0
     ORDER BY pp.tradingsymbol`,
    [portfolioId],
  );

  if (!rows.length) return [];

  const totalValue = (rows as any[]).reduce((s, r) => {
    const mktPrice = Number(r.current_price ?? r.buy_price ?? 0);
    return s + Number(r.quantity) * mktPrice;
  }, 0);

  return (rows as any[]).map((r) => {
    const qty = Number(r.quantity);
    const avgCost = Number(r.avg_cost ?? r.buy_price ?? 0);
    const mktPrice = Number(r.current_price ?? avgCost);
    const invested = qty * avgCost;
    const mktVal = qty * mktPrice;
    const unrealizedPnl = mktVal - invested;

    return {
      ticker: r.tradingsymbol,
      instrumentId: r.resolved_instrument_id ?? r.instrument_id ?? 0,
      quantity: qty,
      avgCost,
      marketPrice: mktPrice,
      marketValue: mktVal,
      investedValue: invested,
      weight: totalValue > 0 ? parseFloat(((mktVal / totalValue) * 100).toFixed(2)) : 0,
      unrealizedPnl,
      unrealizedPnlPct: invested > 0 ? parseFloat(((unrealizedPnl / invested) * 100).toFixed(2)) : 0,
      sector: r.sector ?? null,
    };
  });
}

// ── P&L Service ─────────────────────────────────────────────────

export async function computePnl(portfolioId: number): Promise<PnlSummary> {
  const holdings = await getHoldings(portfolioId);

  const totalInvested = holdings.reduce((s, h) => s + h.investedValue, 0);
  const currentValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const unrealizedPnl = currentValue - totalInvested;
  const unrealizedPnlPct = totalInvested > 0 ? (unrealizedPnl / totalInvested) * 100 : 0;

  // Realized P&L from closed transactions
  const { rows: txnRows } = await db.query(
    `SELECT COALESCE(SUM(
       CASE WHEN side = 'sell' THEN quantity * price ELSE -(quantity * price) END
     ), 0) AS net_flow
     FROM transactions WHERE portfolio_id = ?`,
    [portfolioId],
  );
  const realizedPnl = Number((txnRows[0] as any)?.net_flow ?? 0);

  // Also check trade_journal for realized P&L
  const { rows: journalRows } = await db.query(
    `SELECT COALESCE(SUM(pnl), 0) AS total_realized
     FROM trade_journal tj
     JOIN portfolios p ON tj.user_id = p.user_id
     WHERE p.id = ? AND tj.exit_date IS NOT NULL`,
    [portfolioId],
  );
  const journalPnl = Number((journalRows[0] as any)?.total_realized ?? 0);
  const totalRealized = realizedPnl || journalPnl;

  const totalPnl = unrealizedPnl + totalRealized;
  const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;

  return {
    totalInvested: parseFloat(totalInvested.toFixed(2)),
    currentValue: parseFloat(currentValue.toFixed(2)),
    unrealizedPnl: parseFloat(unrealizedPnl.toFixed(2)),
    unrealizedPnlPct: parseFloat(unrealizedPnlPct.toFixed(2)),
    realizedPnl: parseFloat(totalRealized.toFixed(2)),
    totalPnl: parseFloat(totalPnl.toFixed(2)),
    totalPnlPct: parseFloat(totalPnlPct.toFixed(2)),
  };
}

// ── Valuation Service ───────────────────────────────────────────

export async function getPortfolioOverview(portfolioId: number): Promise<PortfolioOverview> {
  // Fetch portfolio metadata
  const { rows: pRows } = await db.query(
    `SELECT p.*, b.name AS benchmark_name
     FROM portfolios p
     LEFT JOIN benchmarks b ON p.benchmark_id = b.id
     WHERE p.id = ?`,
    [portfolioId],
  );

  if (!pRows.length) {
    return {
      portfolioId,
      portfolioName: 'Unknown',
      ownerType: 'individual',
      baseCurrency: 'INR',
      benchmark: null,
      holdings: [],
      pnl: { totalInvested: 0, currentValue: 0, unrealizedPnl: 0, unrealizedPnlPct: 0, realizedPnl: 0, totalPnl: 0, totalPnlPct: 0 },
      positionsCount: 0,
      cashBalance: 0,
      totalAum: 0,
      asOf: new Date().toISOString(),
    };
  }

  const portfolio = pRows[0] as any;
  const [holdings, pnl] = await Promise.all([
    getHoldings(portfolioId),
    computePnl(portfolioId),
  ]);

  const totalAum = pnl.currentValue; // cash tracking can be added later

  return {
    portfolioId,
    portfolioName: portfolio.name ?? 'My Portfolio',
    ownerType: portfolio.owner_type ?? 'individual',
    baseCurrency: portfolio.base_currency ?? 'INR',
    benchmark: portfolio.benchmark_name ?? null,
    holdings,
    pnl,
    positionsCount: holdings.length,
    cashBalance: 0, // placeholder — add cash tracking table when needed
    totalAum: parseFloat(totalAum.toFixed(2)),
    asOf: new Date().toISOString(),
  };
}

// ── Snapshot Service (as-of reproducibility) ────────────────────

export async function savePortfolioSnapshot(portfolioId: number): Promise<void> {
  const pnl = await computePnl(portfolioId);
  const holdings = await getHoldings(portfolioId);

  await db.query(
    `INSERT INTO portfolio_snapshots
       (portfolio_id, snapshot_date, total_value, invested_value, pnl, pnl_pct, positions_count)
     VALUES (?, CURDATE(), ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       total_value = VALUES(total_value),
       invested_value = VALUES(invested_value),
       pnl = VALUES(pnl),
       pnl_pct = VALUES(pnl_pct),
       positions_count = VALUES(positions_count)`,
    [portfolioId, pnl.currentValue, pnl.totalInvested, pnl.totalPnl, pnl.totalPnlPct, holdings.length],
  );

  log.info('Saved portfolio snapshot', { portfolioId, value: pnl.currentValue });
}

export async function getPortfolioHistory(
  portfolioId: number,
  days = 90,
): Promise<PortfolioSnapshot[]> {
  const { rows } = await db.query(
    `SELECT * FROM portfolio_snapshots
     WHERE portfolio_id = ? AND snapshot_date >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
     ORDER BY snapshot_date`,
    [portfolioId, days],
  );

  return (rows as any[]).map((r) => ({
    portfolioId: r.portfolio_id,
    date: r.snapshot_date,
    totalValue: Number(r.total_value),
    investedValue: Number(r.invested_value),
    pnl: Number(r.pnl),
    pnlPct: Number(r.pnl_pct),
    positionsCount: Number(r.positions_count),
  }));
}
