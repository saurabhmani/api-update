export const MAINTENANCE_STAGE_NAMES = [
  'market_data',
  'market_data_coverage',
  'universe',
  'signals',
  'risk_geometry',
  'manipulation',
  'scoring_confirmation',
  'history_backfill',
  'backtesting_evaluation',
  'nightly_backtest',
  'learning_review',
  'daily_report',
  'health_snapshot',
] as const;

export type MaintenanceStageName = typeof MAINTENANCE_STAGE_NAMES[number];
export type MaintenanceRunStatus =
  | 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'skipped';

export interface StageCounts {
  expected?: number;
  processed?: number;
  succeeded?: number;
  failed?: number;
}

export interface StageResult {
  status: Extract<MaintenanceRunStatus, 'succeeded' | 'partial' | 'skipped'>;
  counts?: StageCounts;
  metadata?: Record<string, unknown>;
  reason?: string;
}

export interface MaintenanceStage {
  name: MaintenanceStageName;
  dependencies: MaintenanceStageName[];
  critical?: boolean;
  maxAttempts?: number;
  run(context: MaintenanceContext): Promise<StageResult>;
}

export interface MaintenanceContext {
  tradingDate: string;
  runId: string;
  attempt: number;
}

export interface MaintenanceRunRecord {
  runId: string;
  jobName: MaintenanceStageName;
  tradingDate: string;
  status: MaintenanceRunStatus;
  retryCount: number;
  completedAt?: string | null;
  lastError?: string | null;
}

export interface JobRunStore {
  claim(input: { runId: string; jobName: MaintenanceStageName; tradingDate: string; staleAfterMs: number }): Promise<'claimed' | 'completed' | 'busy'>;
  finish(input: { runId: string; jobName: MaintenanceStageName; tradingDate: string; result: StageResult; dependencyRunIds: string[] }): Promise<void>;
  fail(input: { runId: string; jobName: MaintenanceStageName; tradingDate: string; error: string; retryCount: number; dependencyRunIds: string[] }): Promise<void>;
  skip(input: { runId: string; jobName: MaintenanceStageName; tradingDate: string; reason: string; dependencyRunIds: string[] }): Promise<void>;
  getForDate(tradingDate: string): Promise<MaintenanceRunRecord[]>;
}
