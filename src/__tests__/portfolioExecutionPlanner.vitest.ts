import { describe, expect, it, beforeEach } from 'vitest';
import { registerPortfolio, clearPortfolioRegistry } from '@/lib/portfolio/registry/portfolioRegistry';
import { buildPortfolioSnapshot } from '@/lib/portfolio/engine/portfolioEngine';
import { adaptLooseSignal } from '@/lib/portfolio/consumption/signalAdapter';
import { prioritizeSignals } from '@/lib/portfolio/prioritization/signalPrioritization';
import { planExecution, recommendOrderSequence } from '@/lib/portfolio/planner/executionPlanner';

describe('execution planner', () => {
  beforeEach(() => clearPortfolioRegistry());

  it('prioritizes signals without modifying confidence', () => {
    const pf = registerPortfolio({ name: 'Exec', owner: 'trader@quantorus', capital: 2_000_000, cash: 1_500_000 });
    const snapshot = buildPortfolioSnapshot(pf);
    const signals = [
      adaptLooseSignal({ symbol: 'WIPRO', direction: 'BUY', confidence_score: 80, final_score: 75, portfolio_fit_score: 70, recommended_capital: 300_000, recommended_quantity: 500, signal_status: 'APPROVED_SIGNAL', factor_scores: { liquidity: 60 } }),
      adaptLooseSignal({ symbol: 'LT', direction: 'BUY', confidence_score: 65, final_score: 60, portfolio_fit_score: 55, recommended_capital: 2_000_000, recommended_quantity: 100, signal_status: 'APPROVED_SIGNAL', factor_scores: { liquidity: 30 } }),
    ];
    const prioritized = prioritizeSignals(signals, snapshot);
    expect(prioritized[0].signal.confidenceScore).toBe(80);
    expect(prioritized.some((p) => !p.selected)).toBe(true);
  });

  it('generates execution batches with slippage and fees', () => {
    const pf = registerPortfolio({ name: 'Exec', owner: 'trader@quantorus', capital: 5_000_000, cash: 4_000_000 });
    const snapshot = buildPortfolioSnapshot(pf);
    const signals = ['A', 'B', 'C', 'D'].map((symbol, i) => adaptLooseSignal({
      symbol,
      direction: 'BUY',
      confidence_score: 70 + i,
      final_score: 65,
      portfolio_fit_score: 60,
      recommended_capital: 200_000,
      recommended_quantity: 100,
      signal_status: 'APPROVED_SIGNAL',
      factor_scores: { liquidity: 55 },
    }));
    const prioritized = prioritizeSignals(signals, snapshot);
    const plan = planExecution(pf.portfolioId, prioritized, { batchSize: 2 });
    expect(plan.batches.length).toBeGreaterThan(0);
    expect(plan.totalEstimatedFees).toBeGreaterThan(0);
    const sequence = recommendOrderSequence(plan);
    expect(sequence.length).toBe(plan.batches.length);
  });
});
