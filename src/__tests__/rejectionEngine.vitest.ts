import { describe, expect, it, beforeEach } from 'vitest';
import { evaluatePhase2QualityGates } from '@/lib/signal-engine/core/phase2RejectionGates';
import { runRejectionEngine } from '@/lib/signal-engine/core/runRejectionEngine';
import { buildEnhancedFeatures } from '@/lib/signal-engine/features/buildEnhancedFeatures';
import { resetSignalEngineConfigCache } from '@/lib/signal-engine/config/signalEnginePhase2Config';
import type { SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';

const BASE_FEATURES = {
  trend: {
    close: 100, distanceFrom20EmaPct: 8.5,
    closeAbove20Ema: true, closeAbove50Ema: false,
  },
  momentum: { adx: 15, rsi14: 72 },
  volume: { volume: 30_000, avgVolume20: 40_000 },
  volatility: { atrPct: 9.5, atr14: 9.5, dailyRangePct: 3 },
  structure: { breakoutDistancePct: 5.5, recentSupport20: 90, recentResistance20: 105 },
  context: { marketRegime: 'Sideways', liquidityPass: false },
} as unknown as SignalFeatures;

function portfolioFitOk() {
  return {
    fitScore: 60,
    sectorExposureImpact: 'acceptable' as const,
    directionImpact: 'acceptable' as const,
    capitalAvailability: 'sufficient' as const,
    correlationCluster: null,
    correlationPenalty: 0,
    portfolioDecision: 'approved' as const,
    penalties: [] as string[],
  };
}

function executionOk() {
  return {
    status: 'ready' as const,
    actionTag: 'enter_now' as const,
    priorityRank: 1,
    approvalDecision: 'approved' as const,
    reasons: [] as string[],
  };
}

describe('rejection engine (Phase 2)', () => {
  beforeEach(() => {
    resetSignalEngineConfigCache();
    process.env.SIGNAL_ENGINE_CONFIG_VERSION = '2';
    resetSignalEngineConfigCache();
  });

  it('evaluatePhase2QualityGates rejects overextended bullish setups', () => {
    const features = {
      ...BASE_FEATURES,
      enhanced: buildEnhancedFeatures(BASE_FEATURES as SignalFeatures),
    };
    const result = evaluatePhase2QualityGates({
      features,
      strategy: 'bullish_breakout',
      rewardRisk: 1.5,
      confidenceScore: 60,
      direction: 'BUY',
    });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes('overextension') || r.includes('Overextended') || r.includes('above EMA20'))).toBe(true);
  });

  it('runRejectionEngine integrates Phase 2 gates via features input', () => {
    const features = {
      ...BASE_FEATURES,
      enhanced: buildEnhancedFeatures(BASE_FEATURES as SignalFeatures),
    };
    const decision = runRejectionEngine({
      symbol: 'TEST',
      strategy: 'bullish_breakout',
      confidenceScore: 65,
      riskScore: 50,
      rewardRisk: 1.5,
      entryPrice: 100,
      stopLoss: 95,
      atrPct: 9.5,
      volume: 30_000,
      regime: 'Sideways',
      sector: 'IT',
      portfolioFit: portfolioFitOk(),
      executionReadiness: executionOk(),
      features,
      direction: 'BUY',
    });
    expect(decision.rejection_codes.length).toBeGreaterThan(0);
    expect(decision.rejection_reasons.every((r) => r.length > 0)).toBe(true);
  });

  it('Phase 1 config skips Phase 2 quality gates', () => {
    process.env.SIGNAL_ENGINE_CONFIG_VERSION = '1';
    resetSignalEngineConfigCache();
    const features = {
      ...BASE_FEATURES,
      enhanced: buildEnhancedFeatures(BASE_FEATURES as SignalFeatures),
    };
    const result = evaluatePhase2QualityGates({
      features,
      strategy: 'bullish_breakout',
      rewardRisk: 1.5,
      confidenceScore: 60,
    });
    expect(result.passed).toBe(true);
    expect(result.codes).toHaveLength(0);
  });
});
