import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { db } from '@/lib/db';
import { STRATEGY_ENGINE_VERSION } from '@strategy-engine';
import { DEFAULT_BACKTEST_CONFIG } from '../config/defaults';
import { ensureBacktestTables } from '../repository/migrate';
import type { BacktestRunConfig } from '../types';
import { backtestLeaseQueue } from '../queue/leaseQueue';
import { getBacktestProcessorOwner } from '../queue/ownership';
import { ProcessorAuthorityRuntime } from '../queue/processorAuthorityRuntime';
import { processBacktestClaim } from '../queue/processor';

const DB_STATUS = { QUEUED: 'queued', RUNNING: 'running', COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled' } as const;
export type ApiStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
const inflight = new Set<string>();
const processorId = `backtest-monolith:${os.hostname()}:${process.pid}:${process.env.NODE_APP_INSTANCE ?? '0'}`;
const leaseDurationMs = Number(process.env.BACKTEST_WORKER_LEASE_DURATION_MS ?? 60_000);
const configuredEpoch = process.env.BACKTEST_OWNERSHIP_EPOCH == null ? undefined : Number(process.env.BACKTEST_OWNERSHIP_EPOCH);
const monolithAuthority = new ProcessorAuthorityRuntime({processorType:'monolith',configuredOwner:getBacktestProcessorOwner(),configuredEpoch,applicationVersion:process.env.APP_VERSION??process.env.npm_package_version??'monolith',processorId});
export async function getMonolithBacktestReadiness(){const decision=await monolithAuthority.refresh();return{healthy:true,ready:decision.allowed,...monolithAuthority.snapshot()};}

export function normalizeStatus(raw: string | null | undefined): ApiStatus {
  const value = String(raw ?? '').toLowerCase();
  if (value === 'running' || value === 'cancel_requested') return 'RUNNING';
  if (value === 'failed' || value === 'dead') return 'FAILED';
  if (value === 'cancelled' || value === 'canceled') return 'CANCELLED';
  if (value === 'completed' || value === 'success' || value === 'partial_success') return 'COMPLETED';
  return 'QUEUED';
}

export interface QueueResult { runId: string; status: ApiStatus; message: string }

export async function queueBacktestRun(config: BacktestRunConfig, createdBy?: number): Promise<QueueResult> {
  await ensureBacktestTables();
  const merged: BacktestRunConfig = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  const runId = merged.runId ?? uuidv4();
  merged.runId = runId;
  await db.query(
    `INSERT INTO backtest_runs (run_id, name, config_json, status, started_at, progress_percent, current_step, created_by)
     VALUES (?, ?, ?, 'queued', NOW(), 0, 'Queued', ?)`,
    [runId, merged.name ?? 'Default Backtest', JSON.stringify(merged), createdBy == null ? null : String(createdBy)],
  );
  if ((await monolithAuthority.refresh()).allowed) void processBacktestRun(runId).catch(error => console.error('[BacktestQueue] background processing failed', { runId, error }));
  return { runId, status: 'QUEUED', message: 'Backtest queued successfully' };
}

export async function processBacktestRun(runId: string): Promise<{ status: ApiStatus; error?: string }> {
  const authority = await monolithAuthority.refresh(); if (!authority.allowed || authority.authoritativeEpoch==null) return { status: 'QUEUED', error: `monolith Backtest processor not ready: ${authority.reason}` };
  if (inflight.has(runId)) return { status: 'RUNNING', error: 'already in-process on this Node instance' };
  await ensureBacktestTables();
  const claim = await backtestLeaseQueue.claimById(runId, processorId, {
    leaseDurationMs,
    workerVersion: process.env.BACKTEST_WORKER_VERSION ?? 'monolith',
    strategyVersion: STRATEGY_ENGINE_VERSION.contractVersion,
    inputVersion: '1',
    ownershipEpoch: authority.authoritativeEpoch,
    processorType: 'monolith',
  });
  if (!claim) return { status: 'QUEUED', error: 'run is not in queued state' };
  inflight.add(runId);
  try {
    const state = await processBacktestClaim(claim, backtestLeaseQueue, leaseDurationMs, new AbortController().signal);
    return { status: normalizeStatus(state), ...(state === 'lost' ? { error: 'processor lease lost' } : {}) };
  } finally { inflight.delete(runId); }
}

export async function processQueuedBacktestRuns(maxConcurrent = 1): Promise<{ processed: string[]; remaining: number; running: number }> {
  const authority=await monolithAuthority.refresh(); if (!authority.allowed) return { processed: [], remaining: 0, running: 0 };
  await ensureBacktestTables();
  const safeMax = Math.max(0, Math.min(1, Math.floor(maxConcurrent)));
  const { rows }: any = await db.query(`SELECT run_id FROM backtest_runs WHERE status='queued' AND cancellation_requested_at IS NULL ORDER BY started_at ASC LIMIT ?`, [safeMax]);
  const processed = (rows ?? []).map((row: any) => String(row.run_id));
  for (const id of processed) void processBacktestRun(id).catch(error => console.error('[BacktestQueue] drain failed', { runId: id, error }));
  const counts: any = await db.query(`SELECT status, COUNT(*) AS n FROM backtest_runs WHERE status IN ('queued','running','cancel_requested') GROUP BY status`);
  let remaining = 0; let running = 0;
  for (const row of counts.rows ?? []) row.status === 'queued' ? remaining = Number(row.n) : running += Number(row.n);
  return { processed, remaining, running };
}

export { DB_STATUS };
