// ════════════════════════════════════════════════════════════════
//  Phase 6 — Explainable no-trade policy
//
//  Improves rejection quality before raising signal count. Every
//  decision returns an operator-readable reason string.
// ════════════════════════════════════════════════════════════════

import type { SignalFeatures, StrategyName } from '../types/signalEngine.types';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';
import { STRATEGY_REGISTRY } from '../strategies/strategyRegistry';
import type { RejectionCode } from '../core/runRejectionEngine';
import type { StrategyHealthState } from '../governance/strategyHealth';

export const NO_TRADE_POLICY_VERSION = '6.0.0';

export type NoTradeReasonCode =
  | RejectionCode
  | 'mtf_structure_weak'
  | 'event_gap_risk'
  | 'strategy_conflict_unresolved'
  | 'calibration_unsupported'
  | 'strategy_health_restricted'
  | 'conflicting_elite_block';

export interface NoTradeFinding {
  code: NoTradeReasonCode;
  message: string;
  /** Hard no-trade vs soft developing. */
  severity: 'hard' | 'soft';
}

export interface NoTradeEvaluation {
  modelVersion: string;
  blocked: boolean;
  findings: NoTradeFinding[];
  /** Operator-facing lines (always explainable). */
  explain: string[];
}

export interface NoTradeInput {
  features: SignalFeatures;
  strategy: StrategyName;
  confidenceScore: number;
  rewardRisk: number;
  riskScore: number;
  /** From empirical calibration / SetupConfidenceResult. */
  calibrationSampleSize?: number | null;
  calibrationState?: string | null;
  signalTier?: string | null;
  /** MTF overall 0–100 when available. */
  mtfOverallScore?: number | null;
  mtfContradictory?: boolean;
  manipulationScore?: number | null;
  liquidityOk?: boolean;
  dataQualityOk?: boolean;
  stale?: boolean;
  strategyHealth?: StrategyHealthState | null;
  /** Conflicting high-quality opposite-direction strategies without clear winner. */
  unresolvedDirectionConflict?: boolean;
  eliteConflictBothSides?: boolean;
}

/**
 * Evaluate mandatory no-trade conditions. Does not approve trades.
 */
export function evaluateNoTradePolicy(input: NoTradeInput): NoTradeEvaluation {
  const findings: NoTradeFinding[] = [];
  const f = input.features;
  const isShort = BEARISH_STRATEGIES.has(input.strategy);
  const entry = STRATEGY_REGISTRY[input.strategy];

  const hard = (code: NoTradeReasonCode, message: string) =>
    findings.push({ code, message, severity: 'hard' });
  const soft = (code: NoTradeReasonCode, message: string) =>
    findings.push({ code, message, severity: 'soft' });

  // Poor or stale data
  if (input.dataQualityOk === false) {
    hard('data_quality', 'No trade — data quality failed integrity / freshness checks');
  }
  if (input.stale) {
    hard('signal_stale', 'No trade — signal or market data is stale');
  }

  // Weak / contradictory MTF
  if (input.mtfContradictory) {
    hard('mtf_structure_weak', 'No trade — multi-timeframe structure is contradictory');
  } else if (input.mtfOverallScore != null && input.mtfOverallScore < 35) {
    soft('mtf_structure_weak', `MTF support weak (${input.mtfOverallScore}/100) — watchlist only`);
  }

  // Strategy–regime mismatch
  if (entry && !entry.allowedRegimes.includes(f.context.marketRegime)) {
    hard(
      'regime_incompatible',
      `No trade — ${input.strategy} not allowed in ${f.context.marketRegime}`,
    );
  }

  // Insufficient R:R — hard below institutional floor; soft near floor
  if (input.rewardRisk < 1.0) {
    hard(
      'risk_reward_insufficient',
      `No trade — reward/risk ${input.rewardRisk.toFixed(2)} below 1.0 structural floor`,
    );
  } else if (input.rewardRisk < 1.3) {
    soft(
      'risk_reward_insufficient',
      `Reward/risk ${input.rewardRisk.toFixed(2)} below preferred 1.3 — developing / selective`,
    );
  }

  // Excessive gap / event risk
  if (Math.abs(f.volatility.gapPct) > 4) {
    hard(
      'event_gap_risk',
      `No trade — gap ${f.volatility.gapPct.toFixed(1)}% indicates elevated event risk`,
    );
  }

  // Overextended entry
  if (!isShort && f.trend.distanceFrom20EmaPct > 6) {
    hard(
      'overextended_move',
      `No trade — overextended ${f.trend.distanceFrom20EmaPct.toFixed(1)}% above 20 EMA`,
    );
  }
  if (isShort && f.trend.distanceFrom20EmaPct < -6) {
    hard(
      'overextended_move',
      `No trade — overextended ${f.trend.distanceFrom20EmaPct.toFixed(1)}% below 20 EMA`,
    );
  }

  // Manipulation risk
  if (input.manipulationScore != null && input.manipulationScore > 60) {
    hard(
      'manipulation_rejected',
      `No trade — manipulation risk ${input.manipulationScore} exceeds 60`,
    );
  }

  // Illiquidity
  if (input.liquidityOk === false || !f.context.liquidityPass) {
    hard('liquidity_insufficient', 'No trade — liquidity filter failed');
  }

  // Conflicting strategies
  if (input.eliteConflictBothSides) {
    hard(
      'conflicting_elite_block',
      'No trade — contradictory high-quality long and short setups; neither published as elite',
    );
  } else if (input.unresolvedDirectionConflict) {
    hard(
      'strategy_conflict_unresolved',
      'No trade — conflicting strategies without a clear winner',
    );
  }

  // Calibration unsupported for Elite claims only (hard)
  if (
    input.signalTier === 'Elite'
    && (input.calibrationSampleSize == null
      || input.calibrationSampleSize < 40
      || input.calibrationState === 'insufficient_data'
      || input.calibrationState === 'overconfident')
  ) {
    hard(
      'calibration_unsupported',
      'No trade as Elite — confidence unsupported by calibration evidence (sample/state insufficient)',
    );
  } else if (
    input.confidenceScore >= 75
    && (input.calibrationSampleSize == null || input.calibrationSampleSize < 40)
  ) {
    soft(
      'calibration_unsupported',
      'High confidence not yet backed by calibration sample — watchlist preference',
    );
  }

  // Strategy health
  if (input.strategyHealth === 'Retired' || input.strategyHealth === 'Research-only') {
    hard(
      'strategy_health_restricted',
      `No trade — strategy health is ${input.strategyHealth} (historical records retained)`,
    );
  } else if (input.strategyHealth === 'Restricted') {
    soft(
      'strategy_health_restricted',
      'Strategy health Restricted — confirmed publishing blocked; watchlist only',
    );
  }

  // High risk score
  if (input.riskScore > 70) {
    hard('risk_score_exceeded', `No trade — risk score ${input.riskScore} exceeds 70`);
  }

  const hardFindings = findings.filter((x) => x.severity === 'hard');
  return {
    modelVersion: NO_TRADE_POLICY_VERSION,
    blocked: hardFindings.length > 0,
    findings,
    explain: findings.map((x) => x.message),
  };
}
