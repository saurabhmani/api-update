import { describe, expect, it, beforeEach } from 'vitest';
import { scoreConfidenceForStrategy } from '@/lib/signal-engine/scoring/confidenceScorer';
import {
  validateConfidenceInputs,
  computePhase2ConfidenceAdjustment,
  buildConfidenceExplanation,
  applyPhase2ConfidenceCalibration,
} from '@/lib/signal-engine/scoring/confidenceCalibration';
import { buildEnhancedFeatures } from '@/lib/signal-engine/features/buildEnhancedFeatures';
import { resetSignalEngineConfigCache } from '@/lib/signal-engine/config/signalEnginePhase2Config';
import type { RelativeStrengthFeatures, SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';

const RS: RelativeStrengthFeatures = { rsVsIndex: 2, rsVsSector: 1, sectorStrengthScore: 55 };

const BREAKOUT_FEATURES = {
  trend: {
    closeAbove20Ema: true,
    closeAbove50Ema: true,
    ema20Above50: true,
    closeAbove200Ema: true,
    ema50Above200: true,
    close: 100,
  },
  momentum: {
    rsi14: 58,
    macdHistogram: 1,
    roc5: 1,
    roc20: 3,
    adx: 32,
    stochasticK: 50,
  },
  volume: { volumeVs20dAvg: 2.1, obvSlope: 5, volumeClimaxRatio: 1 },
  structure: {
    breakoutDistancePct: 1.0,
    fib382: 98,
    fib50: 97,
    fib618: 96,
    fib786: 95,
    fibZoneMatched: true,
  },
  volatility: { atrPct: 2, gapPct: 0.5 },
  context: { marketRegime: 'Bullish', sector: 'IT' },
} as unknown as SignalFeatures;

describe('confidence calibration (Phase 2)', () => {
  beforeEach(() => {
    resetSignalEngineConfigCache();
  });

  it('Phase 1 config preserves scoreConfidenceForStrategy baseline', () => {
    process.env.SIGNAL_ENGINE_CONFIG_VERSION = '1';
    resetSignalEngineConfigCache();
    const result = scoreConfidenceForStrategy(BREAKOUT_FEATURES, 'bullish_breakout', RS);
    expect(result.finalScore).toBe(87);
    expect(computePhase2ConfidenceAdjustment(BREAKOUT_FEATURES, 'bullish_breakout')).toBe(0);
  });

  it('Phase 2 calibration applies bounded adjustment with enhanced features', () => {
    process.env.SIGNAL_ENGINE_CONFIG_VERSION = '2';
    resetSignalEngineConfigCache();
    const withEnhanced = {
      ...BREAKOUT_FEATURES,
      enhanced: buildEnhancedFeatures(BREAKOUT_FEATURES as SignalFeatures, RS),
    };
    const base = scoreConfidenceForStrategy(BREAKOUT_FEATURES, 'bullish_breakout', RS);
    const adj = computePhase2ConfidenceAdjustment(withEnhanced, 'bullish_breakout');
    expect(adj).toBeGreaterThanOrEqual(-5);
    expect(adj).toBeLessThanOrEqual(5);
    const calibrated = applyPhase2ConfidenceCalibration(base, withEnhanced, 'bullish_breakout');
    expect(calibrated.finalScore).toBe(Math.min(100, Math.max(0, base.finalScore + adj)));
  });

  it('validateConfidenceInputs flags liquidity failures', () => {
    const bad = {
      ...BREAKOUT_FEATURES,
      context: { ...BREAKOUT_FEATURES.context, liquidityPass: false },
    } as SignalFeatures;
    const v = validateConfidenceInputs(bad);
    expect(v.valid).toBe(false);
    expect(v.issues.some((i) => i.includes('Liquidity'))).toBe(true);
  });

  it('buildConfidenceExplanation returns component breakdown', () => {
    const breakdown = scoreConfidenceForStrategy(BREAKOUT_FEATURES, 'bullish_breakout', RS);
    const lines = buildConfidenceExplanation(breakdown, BREAKOUT_FEATURES, 'bullish_breakout', RS, 0);
    expect(lines[0]).toContain('Setup confidence');
    expect(lines[1]).toContain('Components');
  });
});
