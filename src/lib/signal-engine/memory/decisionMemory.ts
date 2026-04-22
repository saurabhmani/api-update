// ════════════════════════════════════════════════════════════════
//  Decision Memory + Portfolio Commentary — Phase 4
// ════════════════════════════════════════════════════════════════

import type { DecisionMemoryEntry, PortfolioCommentary } from '../types/phase4.types';
import type { PortfolioSnapshot } from '../types/phase3.types';
import type { EnhancedMarketRegime } from '../types/signalEngine.types';

// ── Decision Memory ─────────────────────────────────────────

export function createMemoryEntry(
  signalId: number,
  stage: string,
  message: string,
  payload: Record<string, unknown> = {},
): DecisionMemoryEntry {
  return { signalId, stage, message, payload, createdAt: new Date().toISOString() };
}

export function buildSignalTimeline(
  signalId: number,
  events: Array<{ stage: string; message: string; payload?: Record<string, unknown> }>,
): DecisionMemoryEntry[] {
  return events.map(e => createMemoryEntry(signalId, e.stage, e.message, e.payload || {}));
}

// ── Portfolio Commentary ────────────────────────────────────

export function buildPortfolioCommentary(
  portfolio: PortfolioSnapshot,
  regime: EnhancedMarketRegime,
  approvedCount: number,
  deferredCount: number,
): PortfolioCommentary {
  const positions = portfolio.openPositions;
  const totalGross = positions.reduce((s, p) => s + p.grossValue, 0);
  const deployedPct = portfolio.capital > 0 ? Math.round((totalGross / portfolio.capital) * 100) : 0;

  // Sector clustering
  const sectorCounts: Record<string, number> = {};
  for (const p of positions) {
    sectorCounts[p.sector] = (sectorCounts[p.sector] || 0) + 1;
  }
  const topSector = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1])[0];
  const clusterRisk = topSector && topSector[1] >= 3
    ? `Portfolio is concentrated in ${topSector[0]} with ${topSector[1]} positions — diversification risk.`
    : 'Sector diversification is acceptable.';

  // Direction
  const longCount = positions.filter(p => p.side === 'long').length;
  const shortCount = positions.filter(p => p.side === 'short').length;

  // Market tone
  const toneMap: Record<string, string> = {
    'Strong Bullish': 'Market backdrop is strongly constructive — trend-following setups favored.',
    'Bullish': 'Market is constructive with positive structure — continuation setups active.',
    'Sideways': 'Market is range-bound — selective approach required, avoid breakout chasing.',
    'Weak': 'Market shows deterioration — defensive positioning recommended.',
    'Bearish': 'Market is bearish — reduce exposure, favor capital preservation.',
    'High Volatility Risk': 'Elevated volatility — reduce new deployment, tighten stops.',
  };

  return {
    marketToneSummary: toneMap[regime.label] || 'Neutral market conditions.',
    clusterRiskSummary: clusterRisk,
    capitalDeploymentNote: `${deployedPct}% of capital deployed across ${positions.length} positions (${longCount} long, ${shortCount} short). Cash: ${Math.round(portfolio.cashAvailable).toLocaleString()}.`,
    watchlistNote: deferredCount > 0 ? `${deferredCount} signals deferred — monitor for entry conditions.` : 'No deferred signals on watchlist.',
    topOpportunitiesNote: approvedCount > 0 ? `${approvedCount} new signals approved for execution this run.` : 'No new actionable signals in this run.',
  };
}
