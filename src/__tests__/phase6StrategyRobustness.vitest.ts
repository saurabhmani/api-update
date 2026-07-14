/**
 * Phase 6 — Strategy robustness, consensus, selectivity.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  evaluateStrategyConsensus,
  CONSENSUS_MODEL_VERSION,
} from '@/lib/signal-engine/consensus/correlationAwareConsensus';
import { evaluateNoTradePolicy } from '@/lib/signal-engine/core/noTradePolicy';
import {
  assessStrategyHealth,
  setStrategyHealthManual,
  getLatestStrategyHealth,
  getStrategyHealthHistory,
  isStrategyPublishable,
  __resetStrategyHealthLedgerForTests,
} from '@/lib/signal-engine/governance/strategyHealth';
import { resolveConflicts } from '@/lib/signal-engine/strategy-engine/resolveConflicts';
import { rankSignals } from '@/lib/signal-engine/pipeline/rankSignals';
import type {
  SignalFeatures,
  RelativeStrengthFeatures,
  StrategyCandidate,
  EnhancedMarketRegime,
  SectorContext,
  QuantSignal,
  SetupConfidenceResult,
  RiskBreakdown,
  TradePlan,
} from '@/lib/signal-engine/types/signalEngine.types';
import { STRATEGY_REGISTRY } from '@/lib/signal-engine/strategies/strategyRegistry';

function baseFeatures(over: Partial<SignalFeatures> = {}): SignalFeatures {
  return {
    trend: {
      close: 100,
      open: 99,
      ema9: 99,
      ema20: 98,
      ema21: 98,
      ema50: 95,
      sma200: 90,
      ema200: 90,
      closeAbove20Ema: true,
      closeAbove50Ema: true,
      closeAbove200Ema: true,
      ema20Above50: true,
      ema50Above200: true,
      distanceFrom20EmaPct: 2,
      distanceFrom50EmaPct: 5,
      ...over.trend,
    },
    momentum: {
      rsi14: 55,
      macdLine: 0.5,
      macdSignal: 0.2,
      macdHistogram: 0.3,
      roc5: 1,
      roc20: 3,
      stochasticK: 55,
      stochasticD: 50,
      adx: 25,
      bullishDivergence: false,
      bearishDivergence: false,
      ...over.momentum,
    },
    volume: {
      volume: 1e6,
      avgVolume20: 8e5,
      volumeVs20dAvg: 1.3,
      breakoutVolumeRatio: 1.1,
      obv: 1,
      obvSlope: 2,
      vwap: 99,
      volumeClimaxRatio: 1,
      ...over.volume,
    },
    volatility: {
      atr14: 2,
      atrPct: 2,
      bollingerUpper: 105,
      bollingerLower: 95,
      bollingerWidth: 10,
      bollingerPctB: 0.5,
      dailyRangePct: 1.5,
      gapPct: 0.2,
      squeezed: false,
      ...over.volatility,
    },
    structure: {
      recentResistance20: 102,
      recentSupport20: 95,
      breakoutDistancePct: 0.5,
      distanceToResistancePct: -0.5,
      distanceToSupportPct: 5,
      recentHigh20: 102,
      recentLow20: 95,
      isInsideDay: false,
      rangeCompressionRatio: 0.8,
      consecutiveHigherLows: 2,
      consecutiveLowerHighs: 0,
      ...over.structure,
    },
    context: {
      marketRegime: 'Bullish',
      liquidityPass: true,
      ...over.context,
    },
    ...over,
  } as SignalFeatures;
}

const rs: RelativeStrengthFeatures = {
  rsVsIndex: 2,
  rsVsSector: 1,
  sectorStrengthScore: 65,
};

function conf(score: number, tier: SetupConfidenceResult['signalTier'] = 'Actionable'): SetupConfidenceResult {
  const band = score >= 70 ? 'High Conviction' : score >= 55 ? 'Actionable' : 'Watchlist';
  return {
    trendScore: 70,
    momentumScore: 70,
    volumeScore: 70,
    structureScore: 70,
    contextScore: 70,
    rawScore: score,
    penaltyScore: 0,
    finalScore: score,
    band,
    calibratedProbability: null,
    confidenceBand: band,
    factorContributions: [],
    penalties: [],
    calibrationSampleSize: 50,
    calibrationWindow: 'test',
    calibrationState: 'well_calibrated',
    modelVersion: '2.0.0',
    signalTier: tier,
    evidenceLabel: 'test',
  };
}

function risk(): RiskBreakdown {
  return {
    atrRisk: 20,
    gapRisk: 10,
    stopDistanceRisk: 20,
    overextensionRisk: 10,
    liquidityRisk: 10,
    candleVolatilityRisk: 10,
    regimeRisk: 10,
    totalScore: 30,
    band: 'Moderate Risk',
  };
}

function plan(rr = 1.8): TradePlan {
  return {
    entry: { type: 'breakout_confirmation', zoneLow: 99, zoneHigh: 100 },
    stopLoss: 96,
    targets: { target1: 104, target2: 108 },
    rewardRiskApprox: rr,
  };
}

function candidate(
  strategy: StrategyCandidate['strategy'],
  score: number,
  tier: SetupConfidenceResult['signalTier'] = 'Actionable',
): StrategyCandidate {
  return {
    strategy,
    features: baseFeatures(),
    relativeStrength: rs,
    confidence: conf(score, tier),
    risk: risk(),
    tradePlan: plan(),
    reasons: [],
    warnings: [],
  };
}

const regime = {
  label: 'Bullish',
  allowBullishSignals: true,
  details: {} as EnhancedMarketRegime['details'],
  strength: 70,
  volatilityRegime: 'Normal',
  trendSlope: 1,
  confidence: 70,
  dimensions: {} as EnhancedMarketRegime['dimensions'],
  evidence: {} as EnhancedMarketRegime['evidence'],
  hysteresis: {} as EnhancedMarketRegime['hysteresis'],
  modelVersion: '3.0.0',
} as EnhancedMarketRegime;

const sector: SectorContext = {
  sector: 'IT',
  sectorStrengthScore: 70,
  sectorTrendLabel: 'Strong',
  sectorRoc5: 1,
  sectorRoc20: 3,
  stockCountInSector: 10,
};

describe('Phase 6 consensus', () => {
  it('does not count RSI and stochastic twice in momentum family', () => {
    const result = evaluateStrategyConsensus(
      baseFeatures({
        momentum: {
          rsi14: 58,
          macdLine: 0.5,
          macdSignal: 0.2,
          macdHistogram: 0.3,
          roc5: 1,
          roc20: 3,
          stochasticK: 60,
          stochasticD: 55,
          adx: 25,
          bullishDivergence: false,
          bearishDivergence: false,
        },
      }),
      rs,
      'bullish_breakout',
    );
    expect(result.modelVersion).toBe(CONSENSUS_MODEL_VERSION);
    const mom = result.families.find((f) => f.family === 'momentum');
    expect(mom).toBeTruthy();
    const hasBoth = mom!.factors.includes('rsi_band') && mom!.factors.includes('stochastic');
    expect(hasBoth).toBe(false);
    expect(result.suppressedDuplicates.length).toBeGreaterThanOrEqual(1);
  });

  it('dedupes breakout_distance and close_above_resistance', () => {
    const result = evaluateStrategyConsensus(
      baseFeatures({
        structure: {
          recentResistance20: 102,
          recentSupport20: 95,
          breakoutDistancePct: 1,
          distanceToResistancePct: -1,
          distanceToSupportPct: 5,
          recentHigh20: 102,
          recentLow20: 95,
          isInsideDay: false,
          rangeCompressionRatio: 0.7,
          consecutiveHigherLows: 2,
          consecutiveLowerHighs: 0,
        },
      }),
      rs,
      'bullish_breakout',
    );
    const st = result.families.find((f) => f.family === 'structure');
    expect(st).toBeTruthy();
    const both =
      st!.factors.includes('breakout_distance') && st!.factors.includes('close_above_resistance');
    expect(both).toBe(false);
  });
});

describe('Phase 6 no-trade', () => {
  it('explains every hard block', () => {
    const eval_ = evaluateNoTradePolicy({
      features: baseFeatures({
        context: { marketRegime: 'Bearish', liquidityPass: true },
      }),
      strategy: 'bullish_breakout',
      confidenceScore: 80,
      rewardRisk: 0.8,
      riskScore: 40,
    });
    expect(eval_.blocked).toBe(true);
    expect(eval_.explain.every((e) => e.length > 0)).toBe(true);
    expect(eval_.findings.some((f) => f.code === 'regime_incompatible')).toBe(true);
  });
});

describe('Phase 6 conflicts', () => {
  it('blocks elite publish on contradictory high-quality long+short', () => {
    const { extras } = resolveConflicts(
      [
        candidate('bullish_breakout', 78, 'Elite'),
        candidate('bearish_breakdown', 76, 'Elite'),
      ],
      regime,
      sector,
    );
    expect(extras.eliteBlockedForSymbol).toBe(true);
  });

  it('keeps canonical strategy ids — no new strategies in Phase 6', () => {
    expect(STRATEGY_REGISTRY.fibonacci_pullback).toBeTruthy();
    expect(Object.keys(STRATEGY_REGISTRY).some((k) => k.includes('consensus_'))).toBe(false);
  });
});

describe('Phase 6 ranking diversity', () => {
  it('demotes sector concentration without changing confidence', () => {
    const mk = (sym: string, confScore: number): QuantSignal =>
      ({
        symbol: sym,
        timeframe: 'daily',
        signalType: 'bullish_breakout',
        signalSubtype: 'fresh_breakout',
        action: 'BUY',
        marketRegime: 'Bullish',
        marketContextTag: 'Bullish',
        strengthTag: 'Actionable',
        strategyName: 'bullish breakout',
        strategyConfidence: confScore,
        contextScore: 60,
        confidenceScore: confScore,
        confidenceBand: 'Actionable',
        riskScore: 30,
        riskBand: 'Moderate Risk',
        entry: { type: 'breakout_confirmation', zoneLow: 1, zoneHigh: 2 },
        stopLoss: 1,
        targets: { target1: 3, target2: 4 },
        rewardRiskApprox: 2,
        reasons: [],
        warnings: [],
        features: baseFeatures(),
        relativeStrength: rs,
        confidenceBreakdown: conf(confScore),
        riskBreakdown: risk(),
        status: 'active',
        generatedAt: new Date().toISOString(),
        sectorContext: {
          sector: 'IT',
          sectorStrengthScore: 70,
          sectorTrendLabel: 'Strong',
          sectorRoc5: 1,
          sectorRoc20: 2,
          stockCountInSector: 8,
        },
      }) as unknown as QuantSignal;

    const ranked = rankSignals(
      [mk('TCS', 80), mk('INFY', 79), mk('HCLTECH', 78), mk('WIPRO', 77)],
      { maxPerSector: 2, maxPerStrategy: 4 },
    );
    const demoted = ranked.filter((s) =>
      s.warnings.some((w) => w.includes('rank_diversity_demote')),
    );
    expect(demoted.length).toBeGreaterThanOrEqual(1);
    expect(ranked[0].confidenceScore).toBe(80);
  });
});

describe('Phase 6 strategy health', () => {
  beforeEach(() => {
    __resetStrategyHealthLedgerForTests();
  });

  it('versions health changes and never deletes history', () => {
    const a = assessStrategyHealth({
      strategy: 'bullish_breakout',
      sampleSize: 50,
      winRate: 0.55,
      avgPnlR: 0.3,
    });
    expect(a.state).toBe('Active');
    expect(a.version).toBe(1);

    const b = assessStrategyHealth(
      {
        strategy: 'bullish_breakout',
        sampleSize: 50,
        winRate: 0.3,
        avgPnlR: -0.2,
        calibrationDeteriorated: true,
      },
      a,
    );
    expect(b.state).toBe('Restricted');
    expect(b.version).toBe(2);

    const hist = getStrategyHealthHistory('bullish_breakout');
    expect(hist.length).toBe(2);
    expect(getLatestStrategyHealth('bullish_breakout')?.state).toBe('Restricted');
    expect(isStrategyPublishable('Restricted').allowConfirmed).toBe(false);
    expect(isStrategyPublishable('Restricted').allowWatchlist).toBe(true);

    setStrategyHealthManual('bullish_breakout', 'Retired', 'Operator retirement', b);
    expect(getStrategyHealthHistory('bullish_breakout').length).toBe(3);
    expect(isStrategyPublishable('Retired').allowWatchlist).toBe(false);
  });
});
