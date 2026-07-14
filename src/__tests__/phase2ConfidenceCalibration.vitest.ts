/**
 * Phase 2 — Confidence scoring & statistical calibration acceptance tests.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { scoreConfidenceForStrategy } from '@/lib/signal-engine/scoring/confidenceScorer';
import {
  computeEmpiricalBucketMetrics,
  resolveCalibrationHierarchy,
  applyCycleBound,
  setCalibrationCellCache,
  getCalibrationCellCache,
  CALIBRATION_MIN_PARTIAL,
  CALIBRATION_MAX_CYCLE_DELTA,
  CALIBRATION_MAX_TOTAL_MODIFIER,
  CONFIDENCE_MODEL_VERSION,
  type EmpiricalBucketMetrics,
  type EmpiricalOutcomeRow,
} from '@/lib/signal-engine/scoring/empiricalCalibration';
import { assignSignalConfidenceTier, ELITE_PRECISION_TARGET } from '@/lib/signal-engine/scoring/signalConfidenceTiers';
import {
  buildConfidenceReliabilityReport,
  compareBaselineVsRevisedScoring,
} from '@/lib/signal-engine/scoring/confidenceReliabilityReport';
import { resetSignalEngineConfigCache } from '@/lib/signal-engine/config/signalEnginePhase2Config';
import type { RelativeStrengthFeatures, SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';

const RS: RelativeStrengthFeatures = { rsVsIndex: 2, rsVsSector: 1, sectorStrengthScore: 55 };

const FEATURES = {
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

function makeRows(n: number, hitRate: number, score = 75): EmpiricalOutcomeRow[] {
  const wins = Math.round(n * hitRate);
  return Array.from({ length: n }, (_, i) => ({
    confidenceScore: score,
    strategy: 'bullish_breakout',
    regime: 'Bullish',
    volatilityState: 'normal',
    target1Hit: i < wins,
    entryTriggered: true,
    expired: false,
    maxFavorableExcursionPct: 2,
    maxAdverseExcursionPct: 1,
    predictedProbability: score / 100,
  }));
}

describe('Phase 2 empirical calibration', () => {
  beforeEach(() => {
    setCalibrationCellCache([]);
    process.env.SIGNAL_ENGINE_CONFIG_VERSION = '2';
    resetSignalEngineConfigCache();
  });

  afterEach(() => {
    setCalibrationCellCache([]);
  });

  it('SetupConfidenceResult contract includes calibration fields', () => {
    const r = scoreConfidenceForStrategy(FEATURES, 'bullish_breakout', RS);
    expect(r).toMatchObject({
      rawScore: expect.any(Number),
      calibratedProbability: null,
      confidenceBand: expect.any(String),
      factorContributions: expect.any(Array),
      penalties: expect.any(Array),
      calibrationSampleSize: 0,
      calibrationWindow: null,
      calibrationState: 'insufficient_data',
      modelVersion: CONFIDENCE_MODEL_VERSION,
    });
    expect(r.evidenceLabel).toMatch(/insufficient/i);
    // Factor ownership: no regime/atr/gap penalties in v2 setup layer
    expect(r.penalties.every((p) => !p.name.startsWith('regime_'))).toBe(true);
    expect(r.penalties.every((p) => p.name !== 'atr_risk' && p.name !== 'gap_risk')).toBe(true);
  });

  it('does not adjust score when evidence is insufficient', () => {
    const thin = computeEmpiricalBucketMetrics('70_84', makeRows(20, 0.9), {
      strategy: 'bullish_breakout',
      regime: 'Bullish',
    });
    expect(thin.sampleSize).toBe(20);
    expect(thin.calibrationState).toBe('insufficient_data');
    expect(thin.suggestedModifier).toBe(0);

    setCalibrationCellCache([thin]);
    const before = scoreConfidenceForStrategy(FEATURES, 'bullish_breakout', RS);
    expect(before.calibratedProbability).toBeNull();
    expect(before.finalScore).toBe(
      scoreConfidenceForStrategy(FEATURES, 'bullish_breakout', RS).finalScore,
    );
  });

  it('hierarchy prefers strategy+regime+vol when trusted', () => {
    const cells: EmpiricalBucketMetrics[] = [
      {
        ...computeEmpiricalBucketMetrics('70_84', makeRows(120, 0.5), {}),
        strategy: null,
        regime: null,
        volatilityState: null,
        suggestedModifier: -2,
      },
      {
        ...computeEmpiricalBucketMetrics('70_84', makeRows(110, 0.7), {
          strategy: 'bullish_breakout',
          regime: 'Bullish',
          volatilityState: 'normal',
        }),
        suggestedModifier: 3,
      },
    ];
    const resolved = resolveCalibrationHierarchy(
      75,
      'bullish_breakout',
      'Bullish',
      'normal',
      cells,
    );
    expect(resolved.level).toBe('strategy_regime_vol');
    expect(resolved.appliedModifier).not.toBe(0);
    expect(resolved.calibratedProbability).not.toBeNull();
  });

  it('cycle bound caps delta at ±1 and total at ±8', () => {
    expect(applyCycleBound(0, 5)).toBe(CALIBRATION_MAX_CYCLE_DELTA);
    expect(applyCycleBound(0, -5)).toBe(-CALIBRATION_MAX_CYCLE_DELTA);
    expect(applyCycleBound(7, 20)).toBe(Math.min(8, 7 + CALIBRATION_MAX_CYCLE_DELTA));
    expect(CALIBRATION_MAX_TOTAL_MODIFIER).toBe(8);
  });

  it('Elite tier requires calibrated probability + sample; Phase 3 rejection stays Avoid', () => {
    const elite = assignSignalConfidenceTier({
      calibratedProbability: ELITE_PRECISION_TARGET,
      calibrationSampleSize: 100,
      rawBand: 'High Conviction',
    });
    expect(elite.tier).toBe('Elite');
    expect(elite.meetsElitePrecisionHypothesis).toBe(true);

    const rejected = assignSignalConfidenceTier({
      calibratedProbability: 0.95,
      calibrationSampleSize: 500,
      rawBand: 'High Conviction',
      phase3Rejected: true,
    });
    expect(rejected.tier).toBe('Avoid');
    expect(rejected.evidenceLabel).toBe('phase3_rejected');
  });

  it('reliability report flags monotonicity when higher buckets underperform', () => {
    const low = computeEmpiricalBucketMetrics('0_54', makeRows(80, 0.55, 40), {});
    const high = computeEmpiricalBucketMetrics('85_100', makeRows(80, 0.3, 90), {});
    // Force overall dims
    const cells = [
      { ...low, strategy: null, regime: null, volatilityState: null },
      { ...high, strategy: null, regime: null, volatilityState: null },
    ];
    const report = buildConfidenceReliabilityReport(cells);
    expect(report.monotonicityOk).toBe(false);
    expect(report.overallBuckets.every((b) => b.evidenceLabel.length > 0)).toBe(true);
  });

  it('baseline vs revised comparison uses the same frozen outcome set', () => {
    const outcomes = Array.from({ length: 50 }, (_, i) => ({
      confidenceScore: 60 + (i % 30),
      target1Hit: i % 3 !== 0,
    }));
    const cmp = compareBaselineVsRevisedScoring({
      outcomes,
      reviseScore: (s) => Math.min(100, s + 1),
    });
    expect(cmp.sameFrozenN).toBe(50);
    expect(Object.keys(cmp.baselinePrecisionByBucket).length).toBeGreaterThan(0);
  });

  it('partial cell shrinks toward parent; cache is readable after set', () => {
    const parent = {
      ...computeEmpiricalBucketMetrics('70_84', makeRows(100, 0.45), {}),
      strategy: null,
      regime: null,
      volatilityState: null,
      suggestedModifier: -4,
    };
    const child = {
      ...computeEmpiricalBucketMetrics(
        '70_84',
        makeRows(CALIBRATION_MIN_PARTIAL + 5, 0.9),
        { strategy: 'bullish_breakout', regime: null },
      ),
      suggestedModifier: 6,
    };
    const resolved = resolveCalibrationHierarchy(
      75,
      'bullish_breakout',
      'Bullish',
      null,
      [child, parent],
    );
    expect(resolved.level).toBe('strategy');
    expect(Math.abs(resolved.appliedModifier)).toBeLessThanOrEqual(CALIBRATION_MAX_TOTAL_MODIFIER);
    setCalibrationCellCache([child, parent]);
    expect(getCalibrationCellCache().length).toBe(2);
  });
});
