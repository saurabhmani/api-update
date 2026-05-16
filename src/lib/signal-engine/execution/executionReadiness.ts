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

// Spec INSTITUTIONAL §I — per-batch approval-funnel counters. The
// engine is called per-symbol; we aggregate refusals into module-level
// tallies and flush a single [APPROVAL_GATE] line per Phase 3 run via
// `flushApprovalGateAggregator()` (called by generatePhase3Signals at
// scan end). Operators grep `[APPROVAL_GATE]` for the canonical
// rejection breakdown.
interface ApprovalFunnel {
  matched:                   number;
  rejected_low_confidence:   number;  // confidenceBand === 'Avoid'
  rejected_low_final_score:  number;  // (computed by Phase4 scoring upstream)
  rejected_stability:        number;  // (maturity worker — separate)
  rejected_market_regime:    number;  // (rejection engine — separate)
  rejected_volatility:       number;  // (rejection engine — separate)
  rejected_rr:               number;
  rejected_stress:           number;  // (Phase-12 routing — separate)
  rejected_maturity:         number;  // (maturity worker — separate)
  rejected_live_validation:  number;  // (Phase-8 — applied at API read time)
  rejected_position_sizing:  number;
  rejected_portfolio_rejected:number;
  rejected_risk_too_high:    number;
  deferred_portfolio:        number;
  deferred_watchlist_band:   number;
  approved:                  number;
}

const APPROVAL_FUNNEL: ApprovalFunnel = {
  matched: 0, rejected_low_confidence: 0, rejected_low_final_score: 0,
  rejected_stability: 0, rejected_market_regime: 0, rejected_volatility: 0,
  rejected_rr: 0, rejected_stress: 0, rejected_maturity: 0,
  rejected_live_validation: 0, rejected_position_sizing: 0,
  rejected_portfolio_rejected: 0, rejected_risk_too_high: 0,
  deferred_portfolio: 0, deferred_watchlist_band: 0, approved: 0,
};

export function resetApprovalGateAggregator(): void {
  for (const k of Object.keys(APPROVAL_FUNNEL) as Array<keyof ApprovalFunnel>) {
    APPROVAL_FUNNEL[k] = 0;
  }
}

/** Flush the canonical 11-field envelope. Called once per Phase 3
 *  scan from generatePhase3Signals. Also accepts upstream-counted
 *  refusals (low_final_score / market_regime / volatility / stress /
 *  maturity / live_validation) so the funnel stays in one greppable
 *  line even when those gates fire in other modules. */
export function flushApprovalGateAggregator(upstream: {
  rejected_low_final_score?: number;
  rejected_stability?:       number;
  rejected_market_regime?:   number;
  rejected_volatility?:      number;
  rejected_stress?:          number;
  rejected_maturity?:        number;
  rejected_live_validation?: number;
} = {}): void {
  const env: Record<string, number> = {
    matched:                  APPROVAL_FUNNEL.matched,
    rejected_low_confidence:  APPROVAL_FUNNEL.rejected_low_confidence,
    rejected_low_final_score: upstream.rejected_low_final_score ?? APPROVAL_FUNNEL.rejected_low_final_score,
    rejected_stability:       upstream.rejected_stability       ?? APPROVAL_FUNNEL.rejected_stability,
    rejected_market_regime:   upstream.rejected_market_regime   ?? APPROVAL_FUNNEL.rejected_market_regime,
    rejected_volatility:      upstream.rejected_volatility      ?? APPROVAL_FUNNEL.rejected_volatility,
    rejected_rr:              APPROVAL_FUNNEL.rejected_rr,
    rejected_stress:          upstream.rejected_stress          ?? APPROVAL_FUNNEL.rejected_stress,
    rejected_maturity:        upstream.rejected_maturity        ?? APPROVAL_FUNNEL.rejected_maturity,
    rejected_live_validation: upstream.rejected_live_validation ?? APPROVAL_FUNNEL.rejected_live_validation,
    approved:                 APPROVAL_FUNNEL.approved,
  };
  const summary = Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[APPROVAL_GATE] ${summary}`);
  // Detailed extra fields (deferred breakdown + sub-rejections) on a
  // second line so the canonical 11-field envelope stays clean.
  console.log(
    `[APPROVAL_GATE_DETAIL] ` +
    `rejected_position_sizing=${APPROVAL_FUNNEL.rejected_position_sizing} ` +
    `rejected_portfolio=${APPROVAL_FUNNEL.rejected_portfolio_rejected} ` +
    `rejected_risk_too_high=${APPROVAL_FUNNEL.rejected_risk_too_high} ` +
    `deferred_portfolio=${APPROVAL_FUNNEL.deferred_portfolio} ` +
    `deferred_watchlist_band=${APPROVAL_FUNNEL.deferred_watchlist_band}`,
  );
  // Health-check warning when nothing approved despite matches.
  if (APPROVAL_FUNNEL.matched > 0 && APPROVAL_FUNNEL.approved === 0) {
    const dominantReject = Object.entries(env)
      .filter(([k]) => k.startsWith('rejected_') || k.startsWith('deferred_'))
      .sort((a, b) => Number(b[1]) - Number(a[1]))[0];
    console.warn(
      `[APPROVAL_GATE] WARN — 0 approvals from ${APPROVAL_FUNNEL.matched} matches. ` +
      `Dominant gate: ${dominantReject?.[0]}=${dominantReject?.[1]}. ` +
      `Lower the corresponding env knob (CONFIDENCE_BAND_ACTIONABLE / minRewardRisk / ` +
      `risk floor) or investigate the upstream factor scores ([PHASE4_FACTORS]).`,
    );
  }
}

export function evaluateExecutionReadiness(
  confidenceScore: number,
  confidenceBand: string,
  rrTarget1: number,
  portfolioFit: PortfolioFitResult,
  sizing: PositionSizingResult,
  risk: Phase3RiskBreakdown,
  config: Phase3Config,
): ExecutionReadiness {
  APPROVAL_FUNNEL.matched++;
  const reasons: string[] = [];

  // ── Hard rejections ───────────────────────────────────────
  if (sizing.validationStatus === 'invalid') {
    reasons.push(`Position sizing invalid: ${sizing.warnings[0] || 'zero size'}`);
    APPROVAL_FUNNEL.rejected_position_sizing++;
    return { status: 'rejected_due_to_risk', actionTag: 'avoid', priorityRank: null, approvalDecision: 'rejected', reasons };
  }

  if (rrTarget1 < config.minRewardRisk) {
    reasons.push(`Reward:Risk ${rrTarget1.toFixed(1)} below minimum ${config.minRewardRisk}`);
    APPROVAL_FUNNEL.rejected_rr++;
    return { status: 'rejected_due_to_reward_risk', actionTag: 'avoid', priorityRank: null, approvalDecision: 'rejected', reasons };
  }

  if (portfolioFit.portfolioDecision === 'rejected') {
    reasons.push(`Portfolio rejected: ${portfolioFit.penalties[0] || 'fit too low'}`);
    APPROVAL_FUNNEL.rejected_portfolio_rejected++;
    return { status: 'rejected_due_to_correlation', actionTag: 'avoid', priorityRank: null, approvalDecision: 'rejected', reasons };
  }

  if (risk.totalRiskScore > 75) {
    reasons.push(`Total risk ${risk.totalRiskScore} exceeds threshold`);
    APPROVAL_FUNNEL.rejected_risk_too_high++;
    return { status: 'rejected_due_to_risk', actionTag: 'avoid', priorityRank: null, approvalDecision: 'rejected', reasons };
  }

  // ── Deferrals ─────────────────────────────────────────────
  if (portfolioFit.portfolioDecision === 'deferred') {
    reasons.push('Portfolio fit deferred — exposure or capital constraints');
    APPROVAL_FUNNEL.deferred_portfolio++;
    return { status: 'deferred_due_to_portfolio', actionTag: 'watch_only', priorityRank: null, approvalDecision: 'deferred', reasons };
  }

  if (confidenceBand === 'Avoid') {
    reasons.push('Confidence too low for execution');
    APPROVAL_FUNNEL.rejected_low_confidence++;
    return { status: 'watchlist_only', actionTag: 'watch_only', priorityRank: null, approvalDecision: 'deferred', reasons };
  }

  // ── Watchlist ─────────────────────────────────────────────
  // Spec INSTITUTIONAL §I (calibrated 2026-05) — Watchlist-band rows
  // can EARN approval when other quality dimensions compensate. The
  // previous blanket-defer treated 'Watchlist' as a hard veto, which
  // killed every signal whose Phase-1 confidence landed in 55-69. The
  // institutional bar is preserved by the score-ratio check: confidence
  // must be in the upper half of Watchlist (≥ midband) AND R:R must be
  // strong enough (≥ 1.8) AND risk must be moderate (≤ 60). Anything
  // below earns the historical 'deferred' verdict.
  //
  // Lowering CONFIDENCE_ACTIONABLE 70→60 in signalEngine.constants
  // already shrinks the 'Watchlist' band substantially; this rule
  // is the safety net for the residual 55-59 window.
  if (confidenceBand === 'Watchlist') {
    const midband = 60;          // Watchlist runs 55-59 after the band recalibration
    const rrThreshold = 1.8;
    const riskCeiling = 60;
    const earnsApproval =
      confidenceScore >= midband
      && rrTarget1 >= rrThreshold
      && risk.totalRiskScore <= riskCeiling;
    if (earnsApproval) {
      reasons.push(
        `Watchlist confidence ${confidenceScore.toFixed(1)} promoted — ` +
        `RR ${rrTarget1.toFixed(1)} ≥ ${rrThreshold} AND risk ${risk.totalRiskScore} ≤ ${riskCeiling}`,
      );
      APPROVAL_FUNNEL.approved++;
      return { status: 'ready_on_confirmation', actionTag: 'enter_on_confirmation', priorityRank: null, approvalDecision: 'approved', reasons };
    }
    reasons.push('Watchlist-grade confidence — monitor for confirmation');
    APPROVAL_FUNNEL.deferred_watchlist_band++;
    return { status: 'watchlist_only', actionTag: 'watch_only', priorityRank: null, approvalDecision: 'deferred', reasons };
  }

  // ── Ready on confirmation ─────────────────────────────────
  if (sizing.validationStatus === 'capped' || portfolioFit.portfolioDecision === 'approved_with_penalty') {
    reasons.push('Approved with constraints — wait for confirmation');
    APPROVAL_FUNNEL.approved++;
    return { status: 'ready_on_confirmation', actionTag: 'enter_on_confirmation', priorityRank: null, approvalDecision: 'approved', reasons };
  }

  if (risk.totalRiskScore > 55) {
    reasons.push('Elevated risk — enter on confirmation only');
    APPROVAL_FUNNEL.approved++;
    return { status: 'ready_on_confirmation', actionTag: 'enter_on_confirmation', priorityRank: null, approvalDecision: 'approved', reasons };
  }

  // ── Ready ─────────────────────────────────────────────────
  reasons.push('All checks passed — ready for execution');
  APPROVAL_FUNNEL.approved++;
  return {
    status: 'ready',
    actionTag: confidenceBand === 'High Conviction' ? 'enter_now' : 'enter_on_confirmation',
    priorityRank: null,
    approvalDecision: 'approved',
    reasons,
  };
}
