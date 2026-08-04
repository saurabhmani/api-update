export type BacktestQueueStatus = 'queued' | 'running' | 'cancel_requested' | 'cancelled' | 'completed' | 'failed' | 'dead';

const transitions: Record<BacktestQueueStatus, readonly BacktestQueueStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['completed', 'failed', 'cancel_requested', 'queued', 'dead'],
  cancel_requested: ['cancelled', 'failed', 'dead'],
  cancelled: [],
  completed: [],
  failed: ['queued', 'dead'],
  dead: [],
};

export function canTransitionBacktest(from: BacktestQueueStatus, to: BacktestQueueStatus): boolean {
  return transitions[from].includes(to);
}

export function assertBacktestTransition(from: BacktestQueueStatus, to: BacktestQueueStatus): void {
  if (!canTransitionBacktest(from, to)) throw new Error(`Invalid backtest transition: ${from} -> ${to}`);
}

export const BACKTEST_STATE_TRANSITIONS = transitions;
