import { describe, expect, it } from 'vitest';
import {
  createPaperPortfolio,
  simulatePaperEntry,
  evolvePaperPortfolioOnBar,
} from '@/lib/research/paperTrading/researchPaperTrading';

describe('research paper trading', () => {
  it('simulates entry with fees and slippage', () => {
    let portfolio = createPaperPortfolio(100_000);
    const { portfolio: next, event } = simulatePaperEntry({
      portfolio,
      symbol: 'TEST',
      quantity: 10,
      referencePrice: 100,
      barIndex: 1,
      stopLoss: 95,
      target: 110,
    });
    portfolio = next;
    expect(event?.type).toBe('entry');
    expect(portfolio.cash).toBeLessThan(100_000);
    expect(portfolio.positions).toHaveLength(1);
  });

  it('handles stop and partial target exits', () => {
    let portfolio = createPaperPortfolio(100_000);
    const entry = simulatePaperEntry({
      portfolio,
      symbol: 'TEST',
      quantity: 10,
      referencePrice: 100,
      barIndex: 1,
      stopLoss: 95,
      target: 110,
    });
    portfolio = entry.portfolio;
    const stopBar = evolvePaperPortfolioOnBar(portfolio, {
      ts: '2026-01-02', open: 96, high: 98, low: 94, close: 95, volume: 1000,
    }, 2, 'TEST');
    expect(stopBar.events.some((e) => e.type === 'stop')).toBe(true);
    expect(stopBar.portfolio.positions).toHaveLength(0);
  });
});
