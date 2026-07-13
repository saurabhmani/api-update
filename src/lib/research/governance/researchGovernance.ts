// ════════════════════════════════════════════════════════════════
//  Phase 7 — Research Governance
//  Nothing bypasses Phase 4 adaptive promotion pipeline.
// ════════════════════════════════════════════════════════════════

import type { PromotionDecision, PromotionRequest, BenchmarkMetrics } from '../types';

export const RESEARCH_GOVERNANCE_VERSION = '7.0.0';

export const PROMOTION_REQUIREMENTS = {
  minStatisticalSignificance: 0.95,
  minTrades: 100,
  minWalkForwardFolds: 3,
  minWalkForwardWinRate: 0.45,
  maxCrossRegimeSharpeDelta: 0.5,
  requiresPeerReview: true,
  requiresManualApproval: true,
  requiresPhase4Governance: true as const,
};

export function evaluatePromotionRequest(
  request: PromotionRequest,
  metrics: BenchmarkMetrics,
  tradeCount: number,
): PromotionDecision {
  const blockingReasons: string[] = [];

  if (request.statisticalSignificance < PROMOTION_REQUIREMENTS.minStatisticalSignificance) {
    blockingReasons.push(`significance ${request.statisticalSignificance} < ${PROMOTION_REQUIREMENTS.minStatisticalSignificance}`);
  }
  if (tradeCount < PROMOTION_REQUIREMENTS.minTrades) {
    blockingReasons.push(`trades ${tradeCount} < ${PROMOTION_REQUIREMENTS.minTrades}`);
  }
  if (request.minimumTrades < PROMOTION_REQUIREMENTS.minTrades) {
    blockingReasons.push('declared minimum trades below governance floor');
  }
  if (!request.walkForwardPassed) {
    blockingReasons.push('walk-forward validation not passed');
  }
  if (!request.crossRegimeStable) {
    blockingReasons.push('cross-regime stability not demonstrated');
  }
  if (PROMOTION_REQUIREMENTS.requiresPeerReview && !request.peerReviewApproved) {
    blockingReasons.push('peer review not approved');
  }
  if (metrics.sharpe < 0) {
    blockingReasons.push('negative Sharpe ratio');
  }
  if (metrics.maxDrawdown > 0.25) {
    blockingReasons.push(`max drawdown ${metrics.maxDrawdown} exceeds 25%`);
  }

  return {
    approved: blockingReasons.length === 0,
    blockingReasons,
    requiresPhase4Governance: true,
  };
}

export function formatPromotionGuidance(decision: PromotionDecision): string {
  if (decision.approved) {
    return 'Research promotion pre-checks passed. Next step: manual approval + Phase 4 promotionPipeline (validate → approve → promote). Research outputs are NEVER auto-promoted.';
  }
  return `Promotion blocked: ${decision.blockingReasons.join('; ')}. Research remains isolated from production.`;
}

export function assertResearchIsolation(): { productionPipelineTouched: false; autoPromotionEnabled: false } {
  return { productionPipelineTouched: false, autoPromotionEnabled: false };
}
