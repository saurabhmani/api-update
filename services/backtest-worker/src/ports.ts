import type { BacktestClaim, BacktestHeartbeat, BacktestStatus, CompleteBacktestCommand, FailBacktestCommand } from '@contracts/backtest-worker';

export interface BacktestQueuePort {
  claim(processorId: string): Promise<BacktestClaim | null>;
  heartbeat(input: BacktestHeartbeat): Promise<boolean>;
  status(runId: string): Promise<BacktestStatus | null>;
  complete(input: CompleteBacktestCommand): Promise<void>;
  fail(input: FailBacktestCommand): Promise<void>;
  recoverStale(now: Date): Promise<number>;
}

export interface BacktestProcessorPort {
  process(claim: BacktestClaim, signal: AbortSignal): Promise<unknown>;
}
