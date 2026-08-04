import os from 'node:os';
import type { BacktestProcessorOwner } from '@contracts/backtest-worker';

export interface BacktestWorkerConfig {
  owner: BacktestProcessorOwner; enabled: boolean; processorId: string; workerVersion: string;
  pollIntervalMs: number; heartbeatIntervalMs: number; leaseDurationMs: number;
  recoveryIntervalMs: number; maxConcurrency: number; port: number; host: string;
  ownershipEpoch?: number;
}
const positive = (env: NodeJS.ProcessEnv, key: string, fallback: number) => {
  const value = Number(env[key] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
  return value;
};
export function loadBacktestWorkerConfig(env: NodeJS.ProcessEnv = process.env): BacktestWorkerConfig {
  const owner = env.BACKTEST_PROCESSOR_OWNER ?? 'monolith';
  if (!['monolith', 'service', 'disabled'].includes(owner)) throw new Error(`Invalid BACKTEST_PROCESSOR_OWNER: ${owner}`);
  const enabled = env.BACKTEST_WORKER_ENABLED === 'true';
  if (enabled && owner !== 'service') throw new Error('BACKTEST_WORKER_ENABLED=true requires BACKTEST_PROCESSOR_OWNER=service');
  if (owner === 'service' && !enabled) throw new Error('Service ownership requires BACKTEST_WORKER_ENABLED=true');
  const heartbeatIntervalMs = positive(env, 'BACKTEST_WORKER_HEARTBEAT_INTERVAL_MS', 15_000);
  const leaseDurationMs = positive(env, 'BACKTEST_WORKER_LEASE_DURATION_MS', 60_000);
  if (leaseDurationMs < heartbeatIntervalMs * 3) throw new Error('BACKTEST_WORKER_LEASE_DURATION_MS must be at least 3x heartbeat interval');
  const maxConcurrency = positive(env, 'BACKTEST_WORKER_MAX_CONCURRENCY', 1);
  if (maxConcurrency !== 1) throw new Error('BACKTEST_WORKER_MAX_CONCURRENCY must be 1 for staging preparation');
  const ownershipEpoch = env.BACKTEST_OWNERSHIP_EPOCH == null ? undefined : positive(env, 'BACKTEST_OWNERSHIP_EPOCH', 1);
  const instance = env.BACKTEST_WORKER_ID ?? env.NODE_APP_INSTANCE ?? crypto.randomUUID();
  return {
    owner: owner as BacktestProcessorOwner, enabled,
    processorId: `backtest-worker:${os.hostname()}:${process.pid}:${instance}`,
    workerVersion: env.BACKTEST_WORKER_VERSION ?? '0.2.0',
    pollIntervalMs: positive(env, 'BACKTEST_WORKER_POLL_INTERVAL_MS', 1_000), heartbeatIntervalMs, leaseDurationMs,
    recoveryIntervalMs: positive(env, 'BACKTEST_WORKER_RECOVERY_INTERVAL_MS', 30_000), maxConcurrency, ownershipEpoch,
    port: positive(env, 'BACKTEST_WORKER_PORT', 4_800), host: env.BACKTEST_WORKER_HOST ?? '127.0.0.1',
  };
}
export const serviceMayClaimJobs = (config: BacktestWorkerConfig) => config.enabled && config.owner === 'service';
