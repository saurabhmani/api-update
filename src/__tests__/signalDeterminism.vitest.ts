import { describe, expect, it } from 'vitest';
import { buildSignalFeatures } from '@/lib/signal-engine/features/buildSignalFeatures';
import { fingerprintSignalFeatures } from '@/lib/signal-engine/features/featureFingerprint';
import { scoreConfidenceForStrategy } from '@/lib/signal-engine/scoring/confidenceScorer';
import { runPhase4Scoring } from '@/lib/signal-engine/scoring/phase4FactorAdapter';
import type { Candle, RelativeStrengthFeatures } from '@/lib/signal-engine/types/signalEngine.types';

const RS: RelativeStrengthFeatures = { rsVsIndex: 1.5, rsVsSector: 0.5, sectorStrengthScore: 55 };

function syntheticCandles(): Candle[] {
  const out: Candle[] = [];
  let close = 200;
  for (let i = 0; i < 100; i++) {
    close += (i % 5 === 0 ? 1.5 : -0.3);
    out.push({
      ts: `2024-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 800_000,
    });
  }
  return out;
}

describe('signal determinism (Phase 1)', () => {
  it('feature → confidence → phase4 scoring is stable across repeated runs', () => {
    const candles = syntheticCandles();
    const run = () => {
      const features = buildSignalFeatures(candles, 'Sideways');
      const conf = scoreConfidenceForStrategy(features, 'bullish_pullback', RS);
      const phase4 = runPhase4Scoring({
        strategyQuality: conf.finalScore,
        trendAlignment: conf.trendScore,
        momentum: conf.momentumScore,
        volumeConfirmation: conf.volumeScore,
        liquidity: null,
        marketRegime: conf.contextScore ?? 50,
        portfolioFit: 50,
        riskRewardRatio: 2.0,
        volumeVs20dAvg: features.volume.volumeVs20dAvg,
        atrPct: features.volatility.atrPct,
        manipulationScore: null,
        ageBars: 0,
        upstreamStatus: 'APPROVED_SIGNAL',
        strategyName: 'bullish_pullback',
      });
      return {
        fp: fingerprintSignalFeatures(features),
        confidence: conf.finalScore,
        final: phase4.final_score,
        classification: phase4.classification,
      };
    };

    const a = run();
    const b = run();
    expect(a).toEqual(b);
  });

  it('historical replay — same frozen candle window yields same fingerprint', () => {
    const window = syntheticCandles().slice(0, 80);
    const fp1 = fingerprintSignalFeatures(buildSignalFeatures(window, 'Bearish'));
    const fp2 = fingerprintSignalFeatures(buildSignalFeatures(window, 'Bearish'));
    expect(fp1).toBe(fp2);
  });
});
