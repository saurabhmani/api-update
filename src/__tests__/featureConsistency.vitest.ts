import { describe, expect, it } from 'vitest';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';
import { fingerprintSignalFeatures } from '@/lib/signal-engine/features/featureFingerprint';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';

function makeFixtureCandles(n = 120, base = 100): Candle[] {
  const out: Candle[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const close = base + Math.sin(i / 8) * 5 + i * 0.02;
    const open = close - 0.3;
    out.push({
      ts: new Date(start + i * 86400000).toISOString().slice(0, 10),
      open,
      high: close + 1.2,
      low: close - 1.1,
      close,
      volume: 500_000 + (i % 7) * 10_000,
    });
  }
  return out;
}

describe('feature consistency (Phase 1)', () => {
  it('identical candle inputs produce identical feature fingerprints', () => {
    const candles = makeFixtureCandles();
    const a = buildSignalFeatures(candles, 'Sideways');
    const b = buildSignalFeatures(candles, 'Sideways');
    expect(fingerprintSignalFeatures(a)).toBe(fingerprintSignalFeatures(b));
  });

  it('duplicate timestamps are deduped deterministically', () => {
    const candles = makeFixtureCandles(80);
    const dup = [...candles, { ...candles[candles.length - 1] }];
    const once = buildSignalFeatures(candles, 'Bullish');
    const twice = buildSignalFeatures(dup, 'Bullish');
    expect(fingerprintSignalFeatures(once)).toBe(fingerprintSignalFeatures(twice));
  });

  it('regime label affects only context — not trend/momentum math', () => {
    const candles = makeFixtureCandles();
    const bull = buildSignalFeatures(candles, 'Bullish');
    const side = buildSignalFeatures(candles, 'Sideways');
    expect(bull.trend).toEqual(side.trend);
    expect(bull.momentum).toEqual(side.momentum);
    expect(bull.context.marketRegime).not.toBe(side.context.marketRegime);
  });
});
