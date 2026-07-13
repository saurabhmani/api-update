import { describe, expect, it, beforeEach } from 'vitest';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';
import { buildEnhancedFeatures } from '@/lib/signal-engine/features/buildEnhancedFeatures';
import { normalizeFeatureScore } from '@/lib/signal-engine/features/normalizeFeatureScore';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';
import { resetSignalEngineConfigCache } from '@/lib/signal-engine/config/signalEnginePhase2Config';

function makeCandles(n = 120): Candle[] {
  const out: Candle[] = [];
  const start = Date.UTC(2024, 0, 1);
  for (let i = 0; i < n; i++) {
    const close = 200 + Math.sin(i / 6) * 8 + i * 0.05;
    out.push({
      ts: new Date(start + i * 86400000).toISOString().slice(0, 10),
      open: close - 0.5,
      high: close + 1.5,
      low: close - 1.2,
      close,
      volume: 250_000 + i * 2_000,
    });
  }
  return out;
}

describe('feature engineering (Phase 2)', () => {
  beforeEach(() => {
    resetSignalEngineConfigCache();
    delete process.env.SIGNAL_ENGINE_CONFIG_VERSION;
  });

  it('normalizeFeatureScore maps values into 0..100', () => {
    expect(normalizeFeatureScore(5, 0, 10)).toBe(50);
    expect(normalizeFeatureScore(0, 0, 10)).toBe(0);
    expect(normalizeFeatureScore(10, 0, 10)).toBe(100);
  });

  it('buildEnhancedFeatures produces all normalized scores', () => {
    const features = buildSignalFeatures(makeCandles(), 'Bullish');
    const e = features.enhanced!;
    expect(e.trendStrength).toBeGreaterThanOrEqual(0);
    expect(e.trendStrength).toBeLessThanOrEqual(100);
    expect(e.volumeQuality).toBeLessThanOrEqual(100);
    expect(e.multiTimeframeAlignment).toBeLessThanOrEqual(100);
    expect(Object.keys(e).length).toBe(15);
  });

  it('identical inputs produce identical enhanced features', () => {
    const candles = makeCandles();
    const a = buildEnhancedFeatures(buildSignalFeatures(candles, 'Sideways'), { rsVsIndex: 1, rsVsSector: 0, sectorStrengthScore: 55 });
    const b = buildEnhancedFeatures(buildSignalFeatures(candles, 'Sideways'), { rsVsIndex: 1, rsVsSector: 0, sectorStrengthScore: 55 });
    expect(a).toEqual(b);
  });
});
