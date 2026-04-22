// ════════════════════════════════════════════════════════════════
//  Valuation Service — Phase 2
//
//  NAV computation and portfolio valuation as-of a given time.
//  Re-exports overview + snapshot from portfolioLedgerService.
// ════════════════════════════════════════════════════════════════

export {
  getPortfolioOverview,
  savePortfolioSnapshot,
  getPortfolioHistory,
  type PortfolioOverview,
  type PortfolioSnapshot,
} from './portfolioLedgerService';

import { getHoldings } from './portfolioLedgerService';

// ── NAV Calculation ─────────────────────────────────────────────

export interface NavResult {
  portfolioId: number;
  nav: number;
  investedValue: number;
  holdingsValue: number;
  cashBalance: number;
  positionsCount: number;
  asOf: string;
}

export async function computeNav(portfolioId: number): Promise<NavResult> {
  const holdings = await getHoldings(portfolioId);
  const holdingsValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  const investedValue = holdings.reduce((s, h) => s + h.investedValue, 0);

  return {
    portfolioId,
    nav: parseFloat(holdingsValue.toFixed(2)),
    investedValue: parseFloat(investedValue.toFixed(2)),
    holdingsValue: parseFloat(holdingsValue.toFixed(2)),
    cashBalance: 0, // extend when cash tracking is added
    positionsCount: holdings.length,
    asOf: new Date().toISOString(),
  };
}
