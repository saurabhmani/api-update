/**
 * Phase 0 regression guard — pins exact outputs for the three
 * scoring entry points documented in docs/product-a/scoring-terminology.md.
 * Any change to formulas, weights, or thresholds must fail here deliberately.
 */
import { describe, expect, it } from 'vitest';
import { scoreConfidenceForStrategy } from '@/lib/signal-engine/scoring/confidenceScorer';
import {
  calculateFinalScore,
  computeCompositeScore,
  computeFinalScore as computeLegacySixFactorScore,
} from '@/lib/signal-engine/scoring/scoringEngine';
import { computeFinalScore as computeRankerFinalScore } from '@/lib/signal-engine/ranking/dynamicRanker';
import type { RelativeStrengthFeatures, SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';
import type { ValidationVerdict } from '@/lib/signal-engine/validation/postSignalValidator';
import type { FreshnessReport } from '@/lib/signal-engine/freshness/freshnessEngine';

const RS_STUB: RelativeStrengthFeatures = {
  rsVsIndex: 2,
  rsVsSector: 1,
  sectorStrengthScore: 55,
};

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

const FRESHNESS_FIXTURE: FreshnessReport = {
  ageBars: 1,
  ageHours: 0.5,
  freshnessScore: 90,
  decayState: 'fresh',
  urgencyTag: 'high',
  priceDriftPct: 0.2,
  progressToTarget: 0.2,
  overextensionPct: 0.2,
  entryMissed: false,
  adverseR: 0,
  movePct: 0.2,
  stepAgePenalty: 0,
  rotationCapHit: false,
};

const KEEP_VERDICT: ValidationVerdict = {
  action: 'keep',
  reason: null,
  nextStatus: 'active',
  scoreMultiplier: 1,
};

describe('scoring terminology regression (Phase 0)', () => {
  it('scoreConfidenceForStrategy — bullish_breakout fixture', () => {
    const result = scoreConfidenceForStrategy(BREAKOUT_FEATURES, 'bullish_breakout', RS_STUB);
    expect(result.finalScore).toBe(87);
    expect(result.band).toBe('High Conviction');
    expect(result.rawScore).toBe(80);
  });

  it('calculateFinalScore — uniform-70 VALID_SIGNAL fixture', () => {
    const input = {
      strategyQuality: 70,
      trendAlignment: 70,
      momentum: 70,
      volumeConfirmation: 70,
      riskReward: 70,
      liquidity: 70,
      marketRegime: 70,
      portfolioFit: 70,
      manipulationRiskPenalty: 0,
      stalenessPenalty: 0,
      volatilityShockPenalty: 0,
    };
    const result = calculateFinalScore(input);
    expect(result.finalScore).toBe(70);
    expect(result.classification).toBe('VALID_SIGNAL');
    // Phase 0 alias — identical behaviour, no formula change
    expect(computeCompositeScore(input)).toEqual(result);
  });

  it('computeLegacySixFactorScore — HIGH_CONVICTION fixture', () => {
    const result = computeLegacySixFactorScore({
      confidenceScore: 88,
      riskScore: 22,
      riskReward: 2.8,
      portfolioFit: 85,
      regimeAlignment: 80,
      freshnessScore: 95,
    });
    expect(result.finalScore).toBe(86.4);
    expect(result.classification).toBe('HIGH_CONVICTION');
  });

  it('computeRankerFinalScore — rescore-shaped fixture', () => {
    const result = computeRankerFinalScore({
      confidenceScore: 75,
      regimeAlignment: 70,
      portfolioFit: 65,
      marketStance: 'selective',
      direction: 'BUY',
      eventRiskScore: 0.1,
      manipulationPenalty: 2,
      freshness: FRESHNESS_FIXTURE,
      verdict: KEEP_VERDICT,
    });
    expect(result.finalScore).toBe(70.88);
    expect(result.base).toBe(78.38);
    expect(result.contextModifier).toBe(1.045);
    expect(result.freshnessPenalty).toBe(4);
    expect(result.eventRiskPenalty).toBe(1.5);
    expect(result.manipulationPenalty).toBe(2);
  });
});
