// ════════════════════════════════════════════════════════════════
//  Phase 3 — Bounded Action Engine
//
//  Translates a SuspicionBand into an explicit, bounded set of
//  actions. The signal engine and watchlist evaluator both consume
//  this so the policy is in ONE place — change the band→action map
//  here and the entire system stays in sync.
//
//  Every action is small and explainable. We deliberately do NOT
//  expose freeform "do anything" hooks; surveillance must be auditable.
// ════════════════════════════════════════════════════════════════

import type { SuspicionBand } from '../types';

export type ManipulationAction =
  | 'warning_only'
  | 'reduce_rank'
  | 'reduce_confidence'
  | 'increase_risk'
  | 'watchlist_only'
  | 'suppress_signal'
  | 'require_manual_review';

export interface ActionRule {
  band: SuspicionBand;
  /** Actions to apply when a snapshot lands in this band. Order is informational. */
  actions: ManipulationAction[];
  /** How much to reduce confidence (0–100). Used by reduce_confidence action. */
  confidenceDelta: number;
  /** How much to raise risk (0–100). Used by increase_risk action. */
  riskDelta: number;
  /** How many rank slots to demote. Used by reduce_rank action. */
  rankDelta: number;
}

/**
 * Default mapping. Tunable: a config table can override this per-deployment
 * (see loadActionConfig below).
 */
export const DEFAULT_ACTION_RULES: Record<SuspicionBand, ActionRule> = {
  low: {
    band: 'low',
    actions: [],
    confidenceDelta: 0,
    riskDelta: 0,
    rankDelta: 0,
  },
  watch: {
    band: 'watch',
    actions: ['warning_only'],
    confidenceDelta: 0,
    riskDelta: 0,
    rankDelta: 0,
  },
  elevated: {
    band: 'elevated',
    actions: ['warning_only', 'reduce_confidence', 'increase_risk', 'reduce_rank'],
    confidenceDelta: 10,
    riskDelta: 5,
    rankDelta: 2,
  },
  high: {
    band: 'high',
    actions: ['warning_only', 'reduce_confidence', 'increase_risk', 'watchlist_only', 'require_manual_review'],
    confidenceDelta: 20,
    riskDelta: 10,
    rankDelta: 5,
  },
  severe: {
    band: 'severe',
    actions: ['warning_only', 'reduce_confidence', 'increase_risk', 'suppress_signal', 'require_manual_review'],
    confidenceDelta: 25,
    riskDelta: 15,
    rankDelta: 10,
  },
};

export interface ActionDecision {
  band: SuspicionBand;
  actions: ManipulationAction[];
  confidenceDelta: number;
  riskDelta: number;
  rankDelta: number;
  /** True when one of the actions removes the signal from active flow. */
  suppress: boolean;
  /** True when manual review is required before any trading on this name. */
  manualReview: boolean;
}

/**
 * Pure decision function — no DB, no I/O. Config defaults to
 * DEFAULT_ACTION_RULES; passing a custom rule set lets a deployment
 * override policy without changing engine code.
 */
export function decideActions(
  band: SuspicionBand,
  rules: Record<SuspicionBand, ActionRule> = DEFAULT_ACTION_RULES,
): ActionDecision {
  const rule = rules[band] ?? DEFAULT_ACTION_RULES.low;
  return {
    band,
    actions: rule.actions,
    confidenceDelta: rule.confidenceDelta,
    riskDelta: rule.riskDelta,
    rankDelta: rule.rankDelta,
    suppress: rule.actions.includes('suppress_signal'),
    manualReview: rule.actions.includes('require_manual_review'),
  };
}

export function actionExplanation(decision: ActionDecision): string {
  if (decision.actions.length === 0) return 'No action — band is low.';
  const parts: string[] = [];
  if (decision.suppress) parts.push('signal suppressed');
  else if (decision.confidenceDelta > 0) parts.push(`-${decision.confidenceDelta} confidence`);
  if (decision.riskDelta > 0) parts.push(`+${decision.riskDelta} risk`);
  if (decision.rankDelta > 0 && !decision.suppress) parts.push(`-${decision.rankDelta} rank`);
  if (decision.manualReview) parts.push('manual review required');
  return parts.join(', ') || decision.actions.join(', ');
}
