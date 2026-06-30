import { describe, it, expect } from 'vitest';
import {
  normalizeScore,
  normalizeConfidenceBreakdownForPhase4,
  CONFIDENCE_COMPONENT_MAX,
  runPhase4Scoring,
} from './phase4FactorAdapter';

describe('phase4FactorAdapter normalization', () => {
  it('normalizeScore maps raw component max to 0-100', () => {
    expect(normalizeScore(25, 25)).toBe(100);
    expect(normalizeScore(20, 20)).toBe(100);
    expect(normalizeScore(15, 15)).toBe(100);
    expect(normalizeScore(12.5, 25)).toBe(50);
    expect(normalizeScore(0, 25)).toBe(0);
    expect(normalizeScore(30, 25)).toBe(100);
    expect(normalizeScore(null, 25)).toBeNull();
  });

  it('normalizeConfidenceBreakdownForPhase4 uses confidenceScorer maxima', () => {
    const out = normalizeConfidenceBreakdownForPhase4({
      trendScore:    CONFIDENCE_COMPONENT_MAX.trend,
      momentumScore: CONFIDENCE_COMPONENT_MAX.momentum,
      volumeScore:   CONFIDENCE_COMPONENT_MAX.volume,
      contextScore:  CONFIDENCE_COMPONENT_MAX.context,
    });
    expect(out.trendAlignment).toBe(100);
    expect(out.momentum).toBe(100);
    expect(out.volumeConfirmation).toBe(100);
    expect(out.marketRegime).toBe(100);
  });

  it('produces higher final_score with normalized components vs raw', () => {
    const raw = runPhase4Scoring({
      strategyQuality:    70,
      trendAlignment:     20,
      momentum:           15,
      volumeConfirmation: 12,
      marketRegime:       10,
      liquidity:          null,
      portfolioFit:       60,
      riskRewardRatio:    2.0,
    });
    const normalized = runPhase4Scoring({
      strategyQuality:    70,
      trendAlignment:     normalizeScore(20, 25),
      momentum:           normalizeScore(15, 20),
      volumeConfirmation: normalizeScore(12, 20),
      marketRegime:       normalizeScore(10, 15),
      liquidity:          null,
      portfolioFit:       60,
      riskRewardRatio:    2.0,
    });
    expect(normalized.final_score).toBeGreaterThan(raw.final_score);
  });
});
