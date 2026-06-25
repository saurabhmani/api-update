import { describe, it, expect } from 'vitest';
import { computeExecutionCosts } from '../utils/fees';

describe('computeExecutionCosts', () => {
  it('uses flat commission when feeModel is flat', () => {
    const costs = computeExecutionCosts(
      { slippageBps: 10, commissionPerTrade: 20, feeModel: 'flat' },
      100, 110, 100,
    );
    expect(costs.commissionCost).toBe(40);
    expect(costs.slippageCost).toBeGreaterThan(0);
    expect(costs.totalCosts).toBe(costs.commissionCost + costs.slippageCost);
  });

  it('uses NSE delivery fees when feeModel is nse_delivery', () => {
    const costs = computeExecutionCosts(
      { slippageBps: 10, commissionPerTrade: 20, feeModel: 'nse_delivery' },
      100, 110, 100,
    );
    expect(costs.commissionCost).toBeGreaterThan(40);
  });
});
