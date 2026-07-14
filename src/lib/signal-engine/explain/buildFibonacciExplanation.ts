// ════════════════════════════════════════════════════════════════
//  Fibonacci Pullback 2.0 explanation helper
// ════════════════════════════════════════════════════════════════

import type { FibonacciPullbackSnapshot } from '../types/signalEngine.types';

export function buildFibonacciPullbackExplanation(
  snap: FibonacciPullbackSnapshot | null | undefined,
): string[] {
  if (!snap) return [];
  return [
    ...snap.explain,
    `Entry trigger: ${snap.confirmationState === 'actionable_confirmation' ? 'reaction confirmed' : 'awaiting reaction'}`,
    ...snap.failureReasons.map((r) => `Risk: ${r}`),
  ];
}
