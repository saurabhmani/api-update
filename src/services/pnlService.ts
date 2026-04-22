// ════════════════════════════════════════════════════════════════
//  P&L Service — Phase 2
//
//  Dedicated P&L computation: unrealized, realized, total.
//  Re-exports computePnl from portfolioLedgerService for
//  standalone consumption by other engines.
// ════════════════════════════════════════════════════════════════

export { computePnl, type PnlSummary } from './portfolioLedgerService';

import { db } from '@/lib/db';
import { getHoldings } from './portfolioLedgerService';

// ── Per-Holding P&L ─────────────────────────────────────────────

export interface HoldingPnl {
  ticker: string;
  quantity: number;
  avgCost: number;
  marketPrice: number;
  invested: number;
  currentValue: number;
  unrealizedPnl: number;
  unrealizedPnlPct: number;
  sector: string | null;
}

export async function getHoldingsPnl(portfolioId: number): Promise<HoldingPnl[]> {
  const holdings = await getHoldings(portfolioId);
  return holdings.map((h) => ({
    ticker: h.ticker,
    quantity: h.quantity,
    avgCost: h.avgCost,
    marketPrice: h.marketPrice,
    invested: h.investedValue,
    currentValue: h.marketValue,
    unrealizedPnl: h.unrealizedPnl,
    unrealizedPnlPct: h.unrealizedPnlPct,
    sector: h.sector,
  }));
}

// ── Realized P&L by Ticker ──────────────────────────────────────

export async function getRealizedPnlByTicker(portfolioId: number): Promise<Record<string, number>> {
  const { rows } = await db.query(
    `SELECT ticker, SUM(CASE WHEN side='sell' THEN quantity*price ELSE -(quantity*price) END) AS net
     FROM transactions WHERE portfolio_id = ? GROUP BY ticker`,
    [portfolioId],
  );
  const result: Record<string, number> = {};
  for (const r of rows as any[]) {
    result[r.ticker] = Number(r.net ?? 0);
  }
  return result;
}
