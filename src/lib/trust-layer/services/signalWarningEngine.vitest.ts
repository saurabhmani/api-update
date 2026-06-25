import { describe, it, expect } from 'vitest';
import { buildWarnings } from '@/lib/signal-engine/explain/buildWarnings';
import type { SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';

describe('signalWarningEngine', () => {
  it('returns warnings array for feature input', () => {
    const features = {
      trend: { distanceFrom20EmaPct: 4, distanceFrom50EmaPct: 7, closeAbove20Ema: true },
      momentum: { rsi14: 72, adx: 15, bearishDivergence: false, stochasticK: 70 },
      volatility: { atrPct: 4, gapPct: 2, dailyRangePct: 4, bollingerPctB: 0.8 },
      structure: { breakoutDistancePct: 3, isInsideDay: false },
      volume: { volumeVs20dAvg: 1.2, obvSlope: -6 },
    } as unknown as SignalFeatures;

    const warnings = buildWarnings(features, 'bullish_breakout');
    expect(Array.isArray(warnings)).toBe(true);
  });
});
