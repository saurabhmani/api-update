import { describe, expect, it, beforeEach } from 'vitest';
import {
  registerPortfolio,
  clearPortfolioRegistry,
  updatePortfolio,
} from '@/lib/portfolio/registry/portfolioRegistry';
import {
  buildPortfolioSnapshot,
  createPosition,
  markPositionsToMarket,
  computeBuyingPower,
} from '@/lib/portfolio/engine/portfolioEngine';
import { adaptLooseSignal } from '@/lib/portfolio/consumption/signalAdapter';
import { runPortfolioIntelligence } from '@/lib/portfolio/intelligence/runPortfolioIntelligence';
import { assertPortfolioIsolation } from '@/lib/portfolio/governance/portfolioGovernance';

describe('portfolio engine', () => {
  beforeEach(() => clearPortfolioRegistry());

  it('asserts production isolation', () => {
    const iso = assertPortfolioIsolation();
    expect(iso.productionPipelineTouched).toBe(false);
    expect(iso.autoExecutionEnabled).toBe(false);
    expect(iso.signalGenerationModified).toBe(false);
  });

  it('tracks positions, cash, allocations, and buying power', () => {
    const pf = registerPortfolio({ name: 'Institutional', owner: 'desk@quantorus', capital: 1_000_000, cash: 600_000 });
    const pos = createPosition({ symbol: 'RELIANCE', quantity: 100, avgPrice: 2500, currentPrice: 2600, direction: 'long' });
    const withPos = updatePortfolio(pf.portfolioId, { positions: [{ ...pos, weight: 0.26 }] });
    const snapshot = buildPortfolioSnapshot(withPos);
    expect(snapshot.cash).toBe(600_000);
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.allocations.RELIANCE).toBeDefined();
    const bp = computeBuyingPower(snapshot.cash, snapshot.grossExposure, 100, snapshot.capital);
    expect(bp).toBeGreaterThan(0);
  });

  it('marks positions to market', () => {
    const pos = createPosition({ symbol: 'TCS', quantity: 50, avgPrice: 4000, currentPrice: 4000, direction: 'long' });
    const marked = markPositionsToMarket([pos], { TCS: 4200 }, 1_000_000);
    expect(marked[0].unrealizedPnl).toBe(10_000);
    expect(marked[0].weight).toBeGreaterThan(0);
  });

  it('runs end-to-end portfolio intelligence on signals', () => {
    const pf = registerPortfolio({ name: 'Alpha', owner: 'pm@quantorus', capital: 5_000_000 });
    const signals = ['HDFCBANK', 'INFY', 'TCS'].map((symbol, i) => adaptLooseSignal({
      symbol,
      direction: 'BUY',
      confidence_score: 75 + i,
      final_score: 70 + i,
      portfolio_fit_score: 65,
      risk_score: 30,
      recommended_quantity: 100,
      recommended_capital: 200_000,
      signal_status: 'APPROVED_SIGNAL',
    }));
    const result = runPortfolioIntelligence({
      portfolioId: pf.portfolioId,
      signals,
      author: 'pm@quantorus',
      allocationMethod: 'equal_weight',
    });
    expect(result.recommendation.signals.length).toBeGreaterThan(0);
    expect(result.report.markdown).toContain('Portfolio Intelligence Report');
    expect(result.audit.autoExecutionBlocked).toBe(true);
  });
});
