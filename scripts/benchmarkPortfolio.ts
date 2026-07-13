#!/usr/bin/env tsx
import 'tsconfig-paths/register';
import { clearPortfolioRegistry, registerPortfolio } from '@/lib/portfolio/registry/portfolioRegistry';
import { adaptLooseSignal } from '@/lib/portfolio/consumption/signalAdapter';
import { runPortfolioIntelligence } from '@/lib/portfolio/intelligence/runPortfolioIntelligence';
import { constructPortfolioAllocation } from '@/lib/portfolio/construction/portfolioConstruction';

const METHODS = ['equal_weight', 'risk_parity', 'sector_balancing', 'volatility_targeting'] as const;

function main(): void {
  clearPortfolioRegistry();
  const started = Date.now();
  const pf = registerPortfolio({ name: 'Benchmark', owner: 'bench@quantorus', capital: 10_000_000, cash: 8_000_000 });

  const symbols = ['RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN'];
  const signals = symbols.map((symbol, i) => adaptLooseSignal({
    symbol,
    direction: 'BUY',
    confidence_score: 60 + i * 3,
    final_score: 55 + i * 2,
    portfolio_fit_score: 50 + i,
    risk_score: 25 + i,
    recommended_quantity: 100 + i * 10,
    recommended_capital: 500_000 + i * 50_000,
    signal_status: 'APPROVED_SIGNAL',
    factor_scores: { liquidity: 50 + i * 5 },
  }));

  const results = METHODS.map((method) => {
    const allocation = constructPortfolioAllocation(method, signals, {
      volatilities: Object.fromEntries(symbols.map((s, i) => [s, 0.15 + i * 0.02])),
      targetVolPct: 12,
    });
    const intel = runPortfolioIntelligence({
      portfolioId: pf.portfolioId,
      signals,
      author: 'bench@quantorus',
      allocationMethod: method,
      replaySeed: 42,
    });
    return {
      method,
      selected: intel.recommendation.signals.filter((s) => s.selected).length,
      capitalUsage: intel.recommendation.executionPlan?.totalCapitalUsage ?? 0,
      weightCount: Object.keys(allocation.weights).length,
    };
  });

  console.log(JSON.stringify({
    benchmark: 'portfolio',
    portfolioId: pf.portfolioId,
    signalCount: signals.length,
    methods: results,
    elapsedMs: Date.now() - started,
  }, null, 2));
}

main();
