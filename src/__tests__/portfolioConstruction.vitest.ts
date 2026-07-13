import { describe, expect, it } from 'vitest';
import { adaptLooseSignal } from '@/lib/portfolio/consumption/signalAdapter';
import {
  buildEqualWeightAllocation,
  buildRiskParityAllocation,
  buildSectorBalancingAllocation,
  buildVolatilityTargetingAllocation,
  buildCustomAllocation,
  constructPortfolioAllocation,
} from '@/lib/portfolio/construction/portfolioConstruction';

describe('portfolio construction', () => {
  const signals = ['A', 'B', 'C'].map((symbol) => adaptLooseSignal({
    symbol,
    direction: 'BUY',
    confidence_score: 70,
    signal_status: 'APPROVED_SIGNAL',
  }));

  it('builds equal weight allocation', () => {
    const plan = buildEqualWeightAllocation(['A', 'B', 'C']);
    expect(Object.keys(plan.weights)).toHaveLength(3);
    expect(plan.method).toBe('equal_weight');
  });

  it('builds risk parity allocation', () => {
    const plan = buildRiskParityAllocation(['A', 'B'], { A: 0.2, B: 0.4 });
    expect(plan.weights.A).toBeGreaterThan(plan.weights.B);
  });

  it('builds sector balancing allocation', () => {
    const plan = buildSectorBalancingAllocation(signals);
    expect(plan.method).toBe('sector_balancing');
  });

  it('builds volatility targeting allocation', () => {
    const plan = buildVolatilityTargetingAllocation(['A', 'B'], { A: 0.15, B: 0.25 }, 12);
    expect(plan.method).toBe('volatility_targeting');
  });

  it('applies custom allocation constraints', () => {
    const plan = buildCustomAllocation({ A: 0.6, B: 0.4 }, { maxSinglePositionPct: 30 });
    expect(plan.method).toBe('custom');
  });

  it('constructs via method dispatcher', () => {
    const plan = constructPortfolioAllocation('equal_weight', signals);
    expect(plan.weights).toBeDefined();
  });
});
