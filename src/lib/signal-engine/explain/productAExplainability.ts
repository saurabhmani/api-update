// ════════════════════════════════════════════════════════════════
//  Phase 2 — Product A Explainability
//
//  Surfaces top contributing features, confidence/risk rationale,
//  and rejection reasons. No hidden scoring factors.
// ════════════════════════════════════════════════════════════════

import type {
  SignalFeatures,
  StrategyName,
  ConfidenceBreakdown,
  RiskBreakdown,
  TradePlan,
  ProductAExplainability,
  RelativeStrengthFeatures,
  FibonacciPullbackSnapshot,
} from '../types/signalEngine.types';
import { buildConfidenceExplanation } from '../scoring/confidenceCalibration';
import { describeTradePlanCalculation } from '../trade-plan/tradePlanEnhancements';
import { computePhase2ConfidenceAdjustment } from '../scoring/confidenceCalibration';
import { buildFibonacciPullbackExplanation } from './buildFibonacciExplanation';

const ENHANCED_FEATURE_LABELS: Record<string, string> = {
  trendStrength: 'Trend strength',
  volumeQuality: 'Volume quality',
  volatilityRegime: 'Volatility regime',
  breakoutQuality: 'Breakout quality',
  liquidityQuality: 'Liquidity quality',
  relativeStrength: 'Relative strength',
  momentumPersistence: 'Momentum persistence',
  riskAdjustedReward: 'Risk-adjusted reward',
  atrEfficiency: 'ATR efficiency',
  emaCompression: 'EMA compression',
  swingStructure: 'Swing structure',
  supportResistanceProximity: 'S/R proximity',
  trendExhaustion: 'Trend exhaustion',
  marketParticipation: 'Market participation',
  multiTimeframeAlignment: 'MTF alignment',
};

function topContributingFeatures(features: SignalFeatures): ProductAExplainability['topContributingFeatures'] {
  const e = features.enhanced;
  if (!e) return [];

  const entries = Object.entries(e)
    .filter(([key]) => key in ENHANCED_FEATURE_LABELS)
    .map(([key, score]) => ({
      feature: ENHANCED_FEATURE_LABELS[key] ?? key,
      score: score as number,
      contribution: (score as number) >= 65
        ? 'Strong positive contributor'
        : (score as number) >= 45
          ? 'Neutral contributor'
          : 'Weak or negative contributor',
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return entries;
}

function buildRiskExplanation(risk: RiskBreakdown, features: SignalFeatures): string[] {
  const lines = [
    `Risk score ${risk.totalScore}/100 (${risk.band})`,
    `ATR risk ${risk.atrRisk}, gap risk ${risk.gapRisk}, stop-distance risk ${risk.stopDistanceRisk}`,
    `Overextension risk ${risk.overextensionRisk}, liquidity risk ${risk.liquidityRisk}`,
  ];
  const e = features.enhanced;
  if (e && e.trendExhaustion > 60) {
    lines.push(`Trend exhaustion elevated at ${e.trendExhaustion}/100`);
  }
  if (e && e.volatilityRegime < 35) {
    lines.push(`Volatility regime unfavorable (${e.volatilityRegime}/100)`);
  }
  return lines;
}

export function buildProductAExplainability(args: {
  features: SignalFeatures;
  strategy: StrategyName;
  confidence: ConfidenceBreakdown;
  risk: RiskBreakdown;
  tradePlan: TradePlan;
  relativeStrength: RelativeStrengthFeatures;
  reasons: string[];
  warnings: string[];
  rejectionReasons?: string[];
  fibonacciSnapshot?: FibonacciPullbackSnapshot | null;
}): ProductAExplainability {
  const adjustment = computePhase2ConfidenceAdjustment(args.features, args.strategy);
  const fibExplain = buildFibonacciPullbackExplanation(args.fibonacciSnapshot);

  return {
    topContributingFeatures: topContributingFeatures(args.features),
    confidenceExplanation: buildConfidenceExplanation(
      args.confidence,
      args.features,
      args.strategy,
      args.relativeStrength,
      adjustment,
    ),
    riskExplanation: buildRiskExplanation(args.risk, args.features),
    tradeRationale: [
      ...fibExplain.slice(0, 6),
      ...args.reasons.slice(0, 3),
      ...describeTradePlanCalculation(args.tradePlan, args.features).slice(0, 3),
    ],
    rejectionReasons: [
      ...(args.rejectionReasons ?? []),
      ...(args.fibonacciSnapshot?.failureReasons ?? []),
    ],
  };
}
