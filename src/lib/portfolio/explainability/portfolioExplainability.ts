// ════════════════════════════════════════════════════════════════
//  Phase 8 — Portfolio Explainability
// ════════════════════════════════════════════════════════════════

import type { PrioritizedSignal, RecommendationExplanation } from '../types';
import type { PortfolioSnapshot } from '../engine/portfolioEngine';
import type { RiskMetrics } from '../types';
import type { AllocationPlan } from '../types';

export function explainRecommendations(
  prioritized: PrioritizedSignal[],
  snapshot: PortfolioSnapshot,
  risk: RiskMetrics,
  allocation?: AllocationPlan,
): RecommendationExplanation[] {
  return prioritized.map((item) => {
    const sym = item.signal.symbol;
    const weight = allocation?.weights[sym] ?? 0;
    const capitalImpact = item.selected
      ? `Deploys ~${item.signal.recommendedCapital.toFixed(0)} (${(weight * 100).toFixed(1)}% target weight)`
      : `No capital deployed`;

    const sectorExp = risk.sectorExposure[item.signal.sector] ?? 0;
    const riskImpact = item.selected
      ? `Sector ${item.signal.sector} exposure ${(sectorExp * 100).toFixed(1)}%; risk score ${item.signal.riskScore}`
      : `Risk avoided: ${item.rejectionReasons.join(', ') || 'low priority'}`;

    const diversificationImpact = item.selected
      ? risk.concentrationHhi > 0.25
        ? 'Increases concentration — monitor HHI'
        : 'Improves or maintains diversification'
      : 'Preserves diversification by skipping overlap';

    return {
      symbol: sym,
      selected: item.selected,
      whySelected: item.selected ? item.explanation : null,
      whyRejected: item.selected ? null : item.rejectionReasons.join('; ') || item.explanation,
      capitalImpact,
      riskImpact,
      diversificationImpact,
    };
  });
}
