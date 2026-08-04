import { describe, expect, it } from 'vitest';
import { validateDeterministicBacktestFixture } from '@/lib/backtesting/parity/fixtureValidation';

describe('deterministic Backtest fixture readiness', () => {
  it('passes every static integrity and runner-suitability category', async () => {
    const report = await validateDeterministicBacktestFixture();
    expect(report.ok).toBe(true);
    expect(report.blockers).toEqual([]);
    expect(Object.values(report.categories).every(category => category.ok)).toBe(true);
    expect(report.counts.perSymbol).toEqual({ 'FIXTURE-A': 280, 'FIXTURE-B': 280, 'FIXTURE-BENCH': 280 });
    expect(report.caveat).toMatch(/does not replace real-runner/i);
  });
});
