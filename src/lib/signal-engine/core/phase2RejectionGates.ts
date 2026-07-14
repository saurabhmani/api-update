// ════════════════════════════════════════════════════════════════
//  Phase 2 — Quality Rejection Gates
//
//  Supplemental gates for weak setups. Runs when config version ≥ 2.
//  Every rejection includes an explainable reason string.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyName } from '../types/signalEngine.types';
import type { RejectionCode, RejectionGateResult } from '../core/runRejectionEngine';
import { getRuntimeSignalEngineConfig } from '../adaptive/runtimeConfiguration';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';

export type Phase2RejectionCode =
  | 'weak_trend'
  | 'poor_liquidity_quality'
  | 'high_spread'
  | 'abnormal_volatility'
  | 'low_confirmation'
  | 'poor_reward_risk'
  | 'late_breakout'
  | 'overextended_move';

export interface Phase2QualityInput {
  features: SignalFeatures;
  strategy: StrategyName;
  rewardRisk: number;
  confidenceScore: number;
  direction?: 'BUY' | 'SELL' | null;
}

export interface Phase2QualityResult {
  passed: boolean;
  gates: RejectionGateResult[];
  codes: Phase2RejectionCode[];
  reasons: string[];
}

function estimateSpreadPct(features: SignalFeatures): number {
  const close = features.trend.close;
  if (close <= 0) return 0;
  return (features.volatility.dailyRangePct / close) * 100 * 0.15;
}

function confirmationScore(features: SignalFeatures, strategy: StrategyName): number {
  const e = features.enhanced;
  if (!e) return 50;

  let score = Math.round(
    e.momentumPersistence * 0.3
    + e.multiTimeframeAlignment * 0.25
    + e.swingStructure * 0.2
    + e.volumeQuality * 0.15
    + e.relativeStrength * 0.1,
  );

  if (strategy === 'bullish_breakout') score = Math.round(score * 0.7 + e.breakoutQuality * 0.3);
  return score;
}

/**
 * Evaluate Phase 2 quality gates. Returns failures without mutating
 * the canonical rejection engine state.
 */
export function evaluatePhase2QualityGates(input: Phase2QualityInput): Phase2QualityResult {
  const config = getRuntimeSignalEngineConfig().config;
  const gates: RejectionGateResult[] = [];
  const codes: Phase2RejectionCode[] = [];
  const reasons: string[] = [];

  if (config.version < 2) {
    return { passed: true, gates: [], codes: [], reasons: [] };
  }

  const { features, strategy, rewardRisk } = input;
  const e = features.enhanced;
  const thresholds = config.rejection;
  const isBullish = !BEARISH_STRATEGIES.has(strategy);

  const record = (code: Phase2RejectionCode, message: string, snapshot?: Record<string, unknown>) => {
    codes.push(code);
    reasons.push(message);
    gates.push({ gate: `phase2_${code}`, passed: false, code: code as RejectionCode, message, snapshot });
  };

  // Weak trend
  if (e && e.trendStrength < thresholds.minTrendStrength && isBullish) {
    record('weak_trend', `Trend strength ${e.trendStrength}/100 below floor ${thresholds.minTrendStrength}`, { trendStrength: e.trendStrength });
  }

  // Poor liquidity quality
  if (e && e.liquidityQuality < thresholds.minLiquidityQuality) {
    record('poor_liquidity_quality', `Liquidity quality ${e.liquidityQuality}/100 below floor ${thresholds.minLiquidityQuality}`, { liquidityQuality: e.liquidityQuality });
  }

  // High spread (estimated from daily range)
  const spreadPct = estimateSpreadPct(features);
  if (spreadPct > thresholds.maxEstimatedSpreadPct) {
    record('high_spread', `Estimated spread ${spreadPct.toFixed(2)}% exceeds ${thresholds.maxEstimatedSpreadPct}%`, { spreadPct });
  }

  // Abnormal volatility
  if (features.volatility.atrPct > thresholds.maxAbnormalAtrPct) {
    record('abnormal_volatility', `ATR ${features.volatility.atrPct.toFixed(2)}% exceeds ${thresholds.maxAbnormalAtrPct}% limit`, { atrPct: features.volatility.atrPct });
  }

  // Low confirmation
  const confScore = confirmationScore(features, strategy);
  if (confScore < thresholds.minConfirmationScore) {
    record('low_confirmation', `Confirmation score ${confScore}/100 below floor ${thresholds.minConfirmationScore}`, { confirmationScore: confScore });
  }

  // Poor reward/risk (supplements existing gate with enhanced estimate)
  if (rewardRisk < thresholds.minRewardRisk) {
    record('poor_reward_risk', `Reward/risk ${rewardRisk.toFixed(2)} below Phase 2 floor ${thresholds.minRewardRisk}`, { rewardRisk });
  }

  // Late breakout
  if (
    isBullish
    && strategy === 'bullish_breakout'
    && features.structure.breakoutDistancePct > thresholds.maxLateBreakoutDistancePct
  ) {
    record(
      'late_breakout',
      `Breakout extension ${features.structure.breakoutDistancePct.toFixed(1)}% exceeds late-breakout limit ${thresholds.maxLateBreakoutDistancePct}%`,
      { breakoutDistancePct: features.structure.breakoutDistancePct },
    );
  }

  // Overextended move
  if (
    isBullish
    && features.trend.distanceFrom20EmaPct > thresholds.maxOverextensionFromEma20Pct
  ) {
    record(
      'overextended_move',
      `Price ${features.trend.distanceFrom20EmaPct.toFixed(1)}% above EMA20 exceeds ${thresholds.maxOverextensionFromEma20Pct}% limit`,
      { distanceFrom20EmaPct: features.trend.distanceFrom20EmaPct },
    );
  }

  // Trend exhaustion for continuation strategies
  if (
    e
    && e.trendExhaustion > config.features.maxTrendExhaustion
    && (strategy === 'momentum_continuation' || strategy === 'bullish_breakout')
  ) {
    record(
      'overextended_move',
      `Trend exhaustion ${e.trendExhaustion}/100 exceeds ${config.features.maxTrendExhaustion} for ${strategy}`,
      { trendExhaustion: e.trendExhaustion },
    );
  }

  // Phase 6 — excessive gap / event risk (explainable)
  if (Math.abs(features.volatility.gapPct) > 4) {
    record(
      'abnormal_volatility',
      `No trade — gap ${features.volatility.gapPct.toFixed(1)}% indicates elevated event risk`,
      { gapPct: features.volatility.gapPct },
    );
  }

  if (gates.length === 0) {
    gates.push({ gate: 'phase2_quality', passed: true });
  }

  return { passed: codes.length === 0, gates, codes, reasons };
}
