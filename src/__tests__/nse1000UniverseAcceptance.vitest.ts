import { describe, it, expect } from 'vitest';
import { ACCEPTANCE_MIN_BARS_DEFAULT } from '@/lib/marketData/nse1000UniverseAcceptance';

describe('nse1000UniverseAcceptance', () => {
  it('defaults acceptance min bars to 80', () => {
    const prev = process.env.UNIVERSE_ACCEPTANCE_MIN_BARS;
    delete process.env.UNIVERSE_ACCEPTANCE_MIN_BARS;
    expect(ACCEPTANCE_MIN_BARS_DEFAULT()).toBe(80);
    if (prev !== undefined) process.env.UNIVERSE_ACCEPTANCE_MIN_BARS = prev;
  });
});
