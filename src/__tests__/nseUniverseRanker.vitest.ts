import { describe, it, expect } from 'vitest';
import { scoreUniverseCandidate } from '@/lib/marketData/nseUniverseRanker';

describe('nseUniverseRanker', () => {
  it('ranks higher traded value and completeness above thin symbols', () => {
    const maxTv = 1_000_000;
    const liquid = scoreUniverseCandidate({
      tradedValue: 900_000,
      volumeConsistency: 0.9,
      candleCompleteness: 0.95,
      maxTradedValue: maxTv,
    });
    const thin = scoreUniverseCandidate({
      tradedValue: 10_000,
      volumeConsistency: 0.2,
      candleCompleteness: 0.1,
      maxTradedValue: maxTv,
    });
    expect(liquid).toBeGreaterThan(thin);
  });

  it('returns zero traded-value contribution when max traded value is zero', () => {
    const score = scoreUniverseCandidate({
      tradedValue: 100_000,
      volumeConsistency: 0.8,
      candleCompleteness: 0.9,
      maxTradedValue: 0,
    });
    expect(score).toBeCloseTo(0.425, 5);
  });

  it('clamps volume consistency and completeness to [0, 1]', () => {
    const score = scoreUniverseCandidate({
      tradedValue: 500_000,
      volumeConsistency: 2,
      candleCompleteness: -1,
      maxTradedValue: 1_000_000,
    });
    expect(score).toBeCloseTo(0.5, 5);
  });
});
