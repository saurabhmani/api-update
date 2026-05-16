// ════════════════════════════════════════════════════════════════
//  Signal Lifecycle Engine — Phase 3
//
//  Manages signal state transitions from generation to archival.
// ════════════════════════════════════════════════════════════════

import type { LifecycleState, SignalLifecycle } from '../types/phase3.types';

const VALID_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  generated:    ['approved', 'rejected', 'expired'],
  approved:     ['ready', 'invalidated', 'expired', 'rejected'],
  ready:        ['entered', 'invalidated', 'expired'],
  entered:      ['archived'],
  invalidated:  ['archived'],
  expired:      ['archived'],
  rejected:     ['archived'],
  archived:     [],
};

export function createLifecycle(
  state: LifecycleState,
  reason: string,
): SignalLifecycle {
  return { state, reason, changedAt: new Date().toISOString() };
}

export function transitionLifecycle(
  current: SignalLifecycle,
  newState: LifecycleState,
  reason: string,
): SignalLifecycle | null {
  const allowed = VALID_TRANSITIONS[current.state];
  if (!allowed || !allowed.includes(newState)) {
    return null; // invalid transition
  }
  return { state: newState, reason, changedAt: new Date().toISOString() };
}

export function resolveInitialState(
  approvalDecision: 'approved' | 'deferred' | 'rejected',
  executionStatus: string,
): { state: LifecycleState; reason: string } {
  if (approvalDecision === 'rejected') {
    return { state: 'rejected', reason: 'Failed execution readiness checks' };
  }
  if (approvalDecision === 'deferred') {
    return { state: 'generated', reason: 'Deferred — awaiting portfolio/market conditions' };
  }
  if (executionStatus === 'ready') {
    return { state: 'ready', reason: 'All checks passed — ready for execution' };
  }
  return { state: 'approved', reason: 'Approved — awaiting confirmation trigger' };
}

// Signal expiration check (default: 5 trading days)
export function isExpired(generatedAt: string, maxAgeDays = 5): boolean {
  const age = Date.now() - new Date(generatedAt).getTime();
  return age > maxAgeDays * 24 * 60 * 60 * 1000;
}
