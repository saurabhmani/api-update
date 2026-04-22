// ════════════════════════════════════════════════════════════════
//  Execution Readiness Engine — Phase 3
//
//  Combines signal quality, trade plan validity, portfolio fit,
//  and risk to determine whether a signal is actionable.
// ════════════════════════════════════════════════════════════════

import type {
  ExecutionReadiness, PortfolioFitResult,
  PositionSizingResult, Phase3RiskBreakdown, Phase3Config,
} from '../types/phase3.types';

export function evaluateExecutionReadiness(
  confidenceScore: number,
  confidenceBand: string,
  rrTarget1: number,
  portfolioFit: PortfolioFitResult,
  sizing: PositionSizingResult,
  risk: Phase3RiskBreakdown,
  config: Phase3Config,
): ExecutionReadiness {
  const reasons: string[] = [];

  // ── Hard rejections ───────────────────────────────────────
  if (sizing.validationStatus === 'invalid') {
    reasons.push(`Position sizing invalid: ${sizing.warnings[0] || 'zero size'}`);
    return { status: 'rejected_due_to_risk', actionTag: 'avoid', priorityRank: null, approvalDecision: 'rejected', reasons };
  }

  if (rrTarget1 < config.minRewardRisk) {
    reasons.push(`Reward:Risk ${rrTarget1.toFixed(1)} below minimum ${config.minRewardRisk}`);
    return { status: 'rejected_due_to_reward_risk', actionTag: 'avoid', priorityRank: null, approvalDecision: 'rejected', reasons };
  }

  if (portfolioFit.portfolioDecision === 'rejected') {
    reasons.push(`Portfolio rejected: ${portfolioFit.penalties[0] || 'fit too low'}`);
    return { status: 'rejected_due_to_correlation', actionTag: 'avoid', priorityRank: null, approvalDecision: 'rejected', reasons };
  }

  if (risk.totalRiskScore > 75) {
    reasons.push(`Total risk ${risk.totalRiskScore} exceeds threshold`);
    return { status: 'rejected_due_to_risk', actionTag: 'avoid', priorityRank: null, approvalDecision: 'rejected', reasons };
  }

  // ── Deferrals ─────────────────────────────────────────────
  if (portfolioFit.portfolioDecision === 'deferred') {
    reasons.push('Portfolio fit deferred — exposure or capital constraints');
    return { status: 'deferred_due_to_portfolio', actionTag: 'watch_only', priorityRank: null, approvalDecision: 'deferred', reasons };
  }

  if (confidenceBand === 'Avoid') {
    reasons.push('Confidence too low for execution');
    return { status: 'watchlist_only', actionTag: 'watch_only', priorityRank: null, approvalDecision: 'deferred', reasons };
  }

  // ── Watchlist ─────────────────────────────────────────────
  if (confidenceBand === 'Watchlist') {
    reasons.push('Watchlist-grade confidence — monitor for confirmation');
    return { status: 'watchlist_only', actionTag: 'watch_only', priorityRank: null, approvalDecision: 'deferred', reasons };
  }

  // ── Ready on confirmation ─────────────────────────────────
  if (sizing.validationStatus === 'capped' || portfolioFit.portfolioDecision === 'approved_with_penalty') {
    reasons.push('Approved with constraints — wait for confirmation');
    return { status: 'ready_on_confirmation', actionTag: 'enter_on_confirmation', priorityRank: null, approvalDecision: 'approved', reasons };
  }

  if (risk.totalRiskScore > 55) {
    reasons.push('Elevated risk — enter on confirmation only');
    return { status: 'ready_on_confirmation', actionTag: 'enter_on_confirmation', priorityRank: null, approvalDecision: 'approved', reasons };
  }

  // ── Ready ─────────────────────────────────────────────────
  reasons.push('All checks passed — ready for execution');
  return {
    status: 'ready',
    actionTag: confidenceBand === 'High Conviction' ? 'enter_now' : 'enter_on_confirmation',
    priorityRank: null,
    approvalDecision: 'approved',
    reasons,
  };
}
