import { describe, expect, it } from 'vitest';
import {
  computePortfolioRiskMetrics,
  computeVaR,
  computeCVaR,
  buildCorrelationMatrix,
  computeConcentrationHhi,
} from '@/lib/portfolio/risk/riskEngine';
import { buildPortfolioSnapshot } from '@/lib/portfolio/engine/portfolioEngine';
import { registerPortfolio, clearPortfolioRegistry } from '@/lib/portfolio/registry/portfolioRegistry';
import { createPosition } from '@/lib/portfolio/engine/portfolioEngine';
import { runStressScenarios } from '@/lib/portfolio/scenarios/scenarioAnalysis';

describe('risk engine', () => {
  it('computes VaR and CVaR', () => {
    const returns = [-0.02, -0.01, 0.01, 0.02, -0.03, 0.005, -0.015];
    expect(computeVaR(returns, 0.95)).toBeGreaterThan(0);
    expect(computeCVaR(returns, 0.95)).toBeGreaterThan(0);
  });

  it('builds correlation matrix', () => {
    const matrix = buildCorrelationMatrix({
      A: [0.01, 0.02, -0.01],
      B: [0.015, 0.018, -0.005],
    });
    expect(matrix.A.B).toBeGreaterThan(0);
    expect(matrix.A.A).toBe(1);
  });

  it('measures portfolio risk metrics', () => {
    clearPortfolioRegistry();
    const pf = registerPortfolio({ name: 'Risk', owner: 'risk@quantorus', capital: 1_000_000 });
    const pos = createPosition({ symbol: 'SBIN', quantity: 200, avgPrice: 600, currentPrice: 620, direction: 'long' });
    const snapshot = buildPortfolioSnapshot({ ...pf, positions: [pos] });
    const risk = computePortfolioRiskMetrics({
      snapshot,
      returns: [0.01, -0.02, 0.005, -0.01, 0.015],
      equityCurve: [1_000_000, 1_010_000, 990_000, 995_000, 985_000, 1_000_000],
    });
    expect(risk.portfolioVolatility).toBeGreaterThanOrEqual(0);
    expect(risk.sectorExposure).toBeDefined();
    expect(computeConcentrationHhi([0.5, 0.5])).toBeLessThan(1);
  });

  it('runs stress scenarios', () => {
    clearPortfolioRegistry();
    const pf = registerPortfolio({ name: 'Stress', owner: 'risk@quantorus', capital: 1_000_000 });
    const pos = createPosition({ symbol: 'ITC', quantity: 500, avgPrice: 450, currentPrice: 460, direction: 'long' });
    const snapshot = buildPortfolioSnapshot({ ...pf, positions: [pos] });
    const scenarios = runStressScenarios(snapshot);
    expect(scenarios).toHaveLength(6);
    expect(scenarios.some((s) => s.scenarioId === 'market_crash')).toBe(true);
  });
});
