export type BacktestProcessorOwner = 'monolith' | 'service' | 'disabled';
export interface BacktestCommand { runId: string; correlationId?: string; workerVersion?: string; }
export interface SubmitBacktestCommand { idempotencyKey: string; inputVersion: string; configuration: unknown; }
export interface BacktestClaim extends BacktestCommand { processorId: string; claimedAt: string; leaseExpiresAt: string; attempt: number; maxAttempts: number; }
export interface BacktestHeartbeat extends BacktestCommand { processorId: string; heartbeatAt: string; progressPercent?: number; }
export interface BacktestStatus { runId: string; status: string; progressPercent?: number; cancellationRequested?: boolean; lastError?: string | null; }
export interface CompleteBacktestCommand extends BacktestCommand { resultVersion: string; result: unknown; }
export interface FailBacktestCommand extends BacktestCommand { failureCategory: string; error: string; retryable: boolean; }
