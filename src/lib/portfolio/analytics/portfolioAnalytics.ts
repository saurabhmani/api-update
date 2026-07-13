// ════════════════════════════════════════════════════════════════
//  Phase 8 — Portfolio Analytics
// ════════════════════════════════════════════════════════════════

import type { AttributionSlice, PortfolioAnalyticsReport } from '../types';
import type { PortfolioSnapshot } from '../engine/portfolioEngine';
import type { RiskMetrics } from '../types';

function buildAttribution(
  weights: Record<string, number>,
  labelPrefix: string,
): AttributionSlice[] {
  return Object.entries(weights)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([label, contributionPct]) => ({
      label: `${labelPrefix}:${label}`,
      contributionPct: Math.round(contributionPct * 10000) / 100,
      explanation: `${label} contributes ${(contributionPct * 100).toFixed(1)}% of exposure`,
    }));
}

export function buildPortfolioAnalytics(input: {
  snapshot: PortfolioSnapshot;
  risk: RiskMetrics;
  returnsByPeriod?: Record<string, number>;
  benchmarkReturn?: number;
}): PortfolioAnalyticsReport {
  const portfolioAttribution = buildAttribution(input.snapshot.allocations, 'symbol');
  const sectorAttribution = buildAttribution(input.risk.sectorExposure, 'sector');
  const strategyAttribution: AttributionSlice[] = input.snapshot.positions.map((p) => ({
    label: p.symbol,
    contributionPct: Math.round(p.weight * 10000) / 100,
    explanation: `${p.symbol} ${p.direction} position weight ${(p.weight * 100).toFixed(1)}%`,
  }));

  const riskAttribution: AttributionSlice[] = [
    { label: 'volatility', contributionPct: input.risk.portfolioVolatility * 100, explanation: `Portfolio vol ${(input.risk.portfolioVolatility * 100).toFixed(1)}%` },
    { label: 'var', contributionPct: input.risk.valueAtRisk95 * 100, explanation: `VaR(95) ${(input.risk.valueAtRisk95 * 100).toFixed(2)}%` },
    { label: 'concentration', contributionPct: input.risk.concentrationHhi * 100, explanation: `HHI concentration ${input.risk.concentrationHhi.toFixed(3)}` },
  ];

  const totalReturn = input.snapshot.realizedPnl + input.snapshot.unrealizedPnl;
  const performanceAttribution: AttributionSlice[] = [
    { label: 'realized', contributionPct: input.snapshot.realizedPnl, explanation: `Realized PnL ${input.snapshot.realizedPnl.toFixed(0)}` },
    { label: 'unrealized', contributionPct: input.snapshot.unrealizedPnl, explanation: `Unrealized PnL ${input.snapshot.unrealizedPnl.toFixed(0)}` },
  ];

  const rollingReturns = Object.entries(input.returnsByPeriod ?? {
    '1M': totalReturn * 0.02,
    '3M': totalReturn * 0.05,
    '6M': totalReturn * 0.08,
    '1Y': totalReturn * 0.12,
  }).map(([period, returnPct]) => ({ period, returnPct: Math.round(returnPct * 100) / 100 }));

  const benchmark = input.benchmarkReturn ?? 0.08;
  const portfolioReturn = rollingReturns.find((r) => r.period === '1Y')?.returnPct ?? 0;

  return {
    portfolioAttribution,
    strategyAttribution,
    sectorAttribution,
    riskAttribution,
    performanceAttribution,
    rollingReturns,
    benchmarkComparison: {
      benchmark: 'NIFTY50',
      alpha: Math.round((portfolioReturn - benchmark) * 100) / 100,
      trackingError: Math.round(input.risk.portfolioVolatility * 100) / 100,
    },
  };
}
