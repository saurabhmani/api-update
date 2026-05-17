// ════════════════════════════════════════════════════════════════
//  Signal Explanation Service — Phase 6
//
//  Produces structured, operator-readable explanations for every
//  decision the platform makes on a signal: why it was generated,
//  why now, why approved/watchlisted/rejected, what confirms it,
//  what invalidates it, what to watch next.
//
//  This module is a PURE composer — it never re-runs detection or
//  scoring. It reads the metadata that the Phase-1 registry, Phase-3
//  router, and Phase-5 confirmation aggregator already produced.
// ════════════════════════════════════════════════════════════════

import {
  STRATEGY_REGISTRY,
  getStrategyMeta,
  getStrategyExplanation,
  getStrategyInvalidation,
} from '@/lib/signal-engine/strategies/strategyRegistry';
import type { StrategyName } from '@/lib/signal-engine/types/signalEngine.types';
import type { ConfirmationAggregate } from '@/lib/confirmation/confirmationAggregator';
import type { StrategyRoutingDecision } from '@/lib/strategies/regimeRouter';

export interface SignalExplanationInput {
  signalId:         string | null;
  symbol:           string;
  strategyId:       string;
  direction:        'BUY' | 'SELL';
  action:           'APPROVED' | 'WATCHLIST' | 'REJECTED' | null;
  confidenceScore:  number | null;
  riskReward:       number | null;
  marketRegime:     string | null;
  freshnessState:   string | null;
  routing?:         StrategyRoutingDecision | null;
  confirmation?:    ConfirmationAggregate   | null;
  rejectionReasons?: string[];
  missingFactors?:  string[];
}

export interface SignalExplanation {
  signalId:                    string | null;
  symbol:                      string;
  strategyId:                  string;
  strategyName:                string;
  whyThisSignal:               string;
  whyNow:                      string;
  strategyRationale:           string;
  approvalDecisionExplanation: string;
  confirmationSummary:         string;
  riskSummary:                 string;
  invalidationSummary:         string;
  nextWatchItems:              string[];
  operatorActions:             string[];
  warnings:                    string[];
}

export function explainSignal(input: SignalExplanationInput): SignalExplanation {
  const meta = getStrategyMeta(input.strategyId);

  const whyThisSignal = getStrategyExplanation(input.strategyId);
  const registryEntry = STRATEGY_REGISTRY[meta.strategyId as StrategyName];
  const idealRegimes = registryEntry?.idealMarketRegime?.join(' / ') || 'specific';
  const strategyRationale = `${meta.strategyName} is a ${meta.strategyCategory.replace(/_/g, ' ')} setup ` +
    `that performs best in ${idealRegimes} regimes.`;

  const whyNow = composeWhyNow(input);
  const approvalDecisionExplanation = composeApprovalDecision(input);
  const confirmationSummary = composeConfirmationSummary(input.confirmation);
  const riskSummary = composeRiskSummary(input);
  const invalidationSummary = `Invalidation: ${getStrategyInvalidation(input.strategyId)}`;
  const nextWatchItems = composeNextWatchItems(input);
  const operatorActions = composeOperatorActions(input);

  const warnings: string[] = [];
  if (input.freshnessState && /stale|expired/i.test(input.freshnessState)) {
    warnings.push('Data freshness is degraded — interpret signal with caution.');
  }
  if (input.routing && (input.routing.routingDecision === 'BLOCK' || input.routing.routingDecision === 'WATCHLIST_ONLY')) {
    warnings.push(input.routing.reason);
  }

  return {
    signalId:     input.signalId,
    symbol:       input.symbol,
    strategyId:   meta.strategyId,
    strategyName: meta.strategyName,
    whyThisSignal,
    whyNow,
    strategyRationale,
    approvalDecisionExplanation,
    confirmationSummary,
    riskSummary,
    invalidationSummary,
    nextWatchItems,
    operatorActions,
    warnings,
  };
}

function composeWhyNow(i: SignalExplanationInput): string {
  if (i.action === 'APPROVED') {
    return `Approval gates cleared and current market conditions support entry.`;
  }
  if (i.routing?.routingDecision === 'WATCHLIST_ONLY' || i.routing?.routingDecision === 'BLOCK') {
    return `Setup is present but current ${i.marketRegime ? `${i.marketRegime} ` : ''}regime restricts approval.`;
  }
  if (i.freshnessState && /stale|pending/i.test(i.freshnessState)) {
    return `Setup is close to confirmation, but approval is pending fresh candle validation.`;
  }
  return `Setup is forming. Confirmation is required before approval.`;
}

function composeApprovalDecision(i: SignalExplanationInput): string {
  switch (i.action) {
    case 'APPROVED':
      return `Approved — signal cleared confidence, risk, and confirmation gates.`;
    case 'WATCHLIST':
      if (i.missingFactors && i.missingFactors.length > 0) {
        return `Watchlist — awaiting: ${i.missingFactors.slice(0, 3).join('; ')}.`;
      }
      return `Watchlist — setup is valid but at least one confirmation factor is still pending.`;
    case 'REJECTED': {
      const reason = i.rejectionReasons?.[0] ?? 'one or more institutional gates were not satisfied';
      return `Rejected — ${reason}.`;
    }
    default:
      return `Decision pending — the approval pipeline has not yet finalised a verdict.`;
  }
}

function composeConfirmationSummary(c: ConfirmationAggregate | null | undefined): string {
  if (!c) return 'No confirmation envelope available for this signal.';
  if (c.approvalRecommendation === 'INSUFFICIENT_DATA') {
    return 'Confirmation modules are largely unavailable — recommendation is not reliable.';
  }
  const positive = c.boosters.length;
  const negative = c.blockers.length;
  return `Confirmation score ${c.confirmationScore} (${positive} supporting, ${negative} restraining). ` +
    `Recommendation: ${c.approvalRecommendation}.`;
}

function composeRiskSummary(i: SignalExplanationInput): string {
  const parts: string[] = [];
  if (typeof i.confidenceScore === 'number') {
    parts.push(`Confidence ${Math.round(i.confidenceScore)}`);
  }
  if (typeof i.riskReward === 'number') {
    parts.push(`R:R ${i.riskReward.toFixed(2)}`);
  }
  if (parts.length === 0) return 'Risk metrics unavailable for this signal.';
  return `${parts.join(' · ')}. Stop-loss is the primary risk control — never widen without explicit reason.`;
}

function composeNextWatchItems(i: SignalExplanationInput): string[] {
  const items: string[] = [];
  if (i.action === 'WATCHLIST' || i.action === null) {
    items.push('Watch for fresh candle close that confirms the setup.');
  }
  if (i.confirmation?.blockers && i.confirmation.blockers.length > 0) {
    items.push(`Watch for change in: ${i.confirmation.blockers[0]}.`);
  }
  if (i.routing?.routingDecision === 'WATCHLIST_ONLY') {
    items.push('Watch for a regime shift that re-opens approval for this strategy.');
  }
  if (items.length === 0) items.push('Watch for the invalidation level — exit if breached.');
  return items.slice(0, 4);
}

function composeOperatorActions(i: SignalExplanationInput): string[] {
  const actions: string[] = [];
  if (i.action === 'APPROVED') {
    actions.push('Review entry zone and place order with the trade plan stop-loss.');
  } else if (i.action === 'WATCHLIST') {
    actions.push('Monitor for confirmation — do not pre-emptively enter.');
  } else if (i.action === 'REJECTED') {
    actions.push('No action recommended — the signal did not clear approval gates.');
  } else {
    actions.push('Wait for the approval pipeline to finalise the verdict.');
  }
  if (i.routing?.routingDecision === 'WATCHLIST_ONLY' || i.routing?.routingDecision === 'BLOCK') {
    actions.push('Open Regime Router to review why approval is restricted today.');
  }
  return actions.slice(0, 3);
}
