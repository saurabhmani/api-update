/**
 * BALANCE §1 + §6 — direction balance contract for the bootstrap
 * EMA/RSI/swing signal builder.
 *
 *   §1 BUY  needs EMA20 > EMA50 AND RSI > 55
 *      SELL needs EMA20 < EMA50 AND RSI < 45
 *      Skip RSI ∈ [45, 55] (neutral) and RSI > 75 / < 25 (extreme).
 *   §6 classifyBias verdict over BUY/SELL counts.
 *
 * Tests fabricate canned daily-bar series whose closes are designed
 * so the resulting EMA20/EMA50 cross + final RSI land in the desired
 * regime. We don't pin exact RSI numbers — instead the test asserts
 * the *direction* of the result, which is what spec BALANCE actually
 * requires.
 */
import { describe, expect, it } from 'vitest';
import {
  buildQualitySignal,
  classifyBias,
  type DailyBar,
} from '@/lib/signal-engine/bootstrap/qualitySignal';

function makeBars(closes: number[], opts: { volume?: number } = {}): DailyBar[] {
  const vol = opts.volume ?? 200_000;
  const start = Date.UTC(2026, 0, 1);
  return closes.map((c, i) => ({
    ts:     new Date(start + i * 24 * 3600 * 1000),
    open:   c * 0.998,
    high:   c * 1.01,
    low:    c * 0.99,
    close:  c,
    volume: vol,
  }));
}

/** Sawtooth-up — alternating +gain / -loss steps with `gain > loss`
 *  produces EMA20 > EMA50 (positive drift) AND RSI ≈ 100 / (1 +
 *  loss/gain). gain=0.5 / loss=0.3 → RSI ≈ 62, comfortably within
 *  the BUY band (55, 75). 80 bars satisfies the 60-bar history floor. */
function uptrendCloses(): number[] {
  const out: number[] = [100];
  for (let i = 1; i < 80; i++) {
    out.push(out[i - 1] + (i % 2 === 0 ? 0.5 : -0.3));
  }
  return out;
}

/** Sawtooth-down — gain=0.3 / loss=0.5 with negative drift. EMA20 <
 *  EMA50, RSI ≈ 38, inside the SELL band (25, 45). */
function downtrendCloses(): number[] {
  const out: number[] = [150];
  for (let i = 1; i < 80; i++) {
    out.push(out[i - 1] + (i % 2 === 0 ? -0.5 : 0.3));
  }
  return out;
}

describe('buildQualitySignal — BUY direction', () => {
  it('returns a BUY signal on an uptrend (EMA20>EMA50, RSI>55)', () => {
    const bars = makeBars(uptrendCloses());
    const result = buildQualitySignal(
      { symbol: 'TESTUP', price: bars[bars.length - 1].close },
      bars,
    );
    expect(result.kind).toBe('signal');
    if (result.kind === 'signal') {
      expect(result.signal.direction).toBe('BUY');
      expect(result.signal.entryPrice).toBeGreaterThan(0);
      expect(result.signal.target1).toBeGreaterThan(result.signal.entryPrice);
      expect(result.signal.stopLoss).toBeLessThan(result.signal.entryPrice);
      expect(result.signal.riskReward).toBeGreaterThanOrEqual(1.5);
    }
  });
});

describe('buildQualitySignal — SELL direction', () => {
  it('returns a SELL signal on a downtrend (EMA20<EMA50, RSI<45)', () => {
    const bars = makeBars(downtrendCloses());
    const result = buildQualitySignal(
      { symbol: 'TESTDN', price: bars[bars.length - 1].close },
      bars,
    );
    expect(result.kind).toBe('signal');
    if (result.kind === 'signal') {
      expect(result.signal.direction).toBe('SELL');
      expect(result.signal.target1).toBeLessThan(result.signal.entryPrice);
      expect(result.signal.stopLoss).toBeGreaterThan(result.signal.entryPrice);
      expect(result.signal.riskReward).toBeGreaterThanOrEqual(1.5);
    }
  });
});

describe('buildQualitySignal — neutral/extreme skips', () => {
  it('skips when daily history has fewer than 60 bars', () => {
    const bars = makeBars(uptrendCloses().slice(0, 30));
    const result = buildQualitySignal({ symbol: 'X', price: 100 }, bars);
    expect(result).toEqual({ kind: 'skip', reason: 'no_history' });
  });

  it('skips on thin volume', () => {
    const bars = makeBars(uptrendCloses(), { volume: 1_000 });
    const result = buildQualitySignal(
      { symbol: 'X', price: bars[bars.length - 1].close },
      bars,
    );
    expect(result.kind).toBe('skip');
    if (result.kind === 'skip') expect(result.reason).toBe('thin_volume');
  });
});

describe('classifyBias — §6', () => {
  it('returns NO_SIGNALS when neither side has any', () => {
    expect(classifyBias(0, 0)).toBe('NO_SIGNALS');
  });
  it('returns BALANCED when minority share ≥ 30%', () => {
    expect(classifyBias(7, 3)).toBe('BALANCED');   // 30%
    expect(classifyBias(5, 5)).toBe('BALANCED');   // 50%
  });
  it('returns BIAS_DETECTED when minority share < 30%', () => {
    expect(classifyBias(8, 2)).toBe('BIAS_DETECTED');   // 20%
    expect(classifyBias(10, 0)).toBe('BIAS_DETECTED');  // 0%
    expect(classifyBias(0, 10)).toBe('BIAS_DETECTED');  // 0% the other way
  });
});
