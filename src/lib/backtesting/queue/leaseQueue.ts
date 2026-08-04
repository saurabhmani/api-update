import { db } from '@/lib/db';
import type { BacktestRunConfig } from '../types';

export interface QueueDb { query<T = any>(sql: string, params?: any[]): Promise<{ rows: T[]; affectedRows?: number }> }
export interface LeaseClaim { runId: string; config: BacktestRunConfig; processorId: string; processorType:'monolith'|'service'; attempt: number; maxAttempts: number; leaseExpiresAt: string; ownershipEpoch:number; queueWaitSeconds?:number; correlationId?: string; }
export interface LeaseQueueOptions { leaseDurationMs: number; workerVersion: string; strategyVersion: string; inputVersion: string; ownershipEpoch:number; processorType:'monolith'|'service'; }
export type UserCancellationResult =
  | { kind: 'cancelled'; changed: true }
  | { kind: 'cancellation_requested'; changed: true }
  | { kind: 'not_actionable'; changed: false; status: string }
  | { kind: 'not_found_or_unauthorized'; changed: false };

const isoSql = (date: Date) => date.toISOString().slice(0, 23).replace('T', ' ');

export class MysqlBacktestLeaseQueue {
  constructor(private readonly database: QueueDb = db, private readonly now: () => Date = () => new Date()) {}
  async authoritativeOwnership():Promise<{owner:string;epoch:number}|null>{const{rows}=await this.database.query<any>('SELECT owner,epoch FROM backtest_processor_ownership WHERE singleton_id=1');return rows[0]?{owner:String(rows[0].owner),epoch:Number(rows[0].epoch)}:null;}

  async claimNext(processorId: string, options: LeaseQueueOptions): Promise<LeaseClaim | null> {
    const { rows } = await this.database.query<{ run_id: string }>(
      `SELECT run_id FROM backtest_runs
       WHERE status='queued' AND cancellation_requested_at IS NULL AND attempt_count < max_attempts
       ORDER BY started_at ASC LIMIT 8`,
    );
    for (const row of rows) {
      const claim = await this.claimById(row.run_id, processorId, options);
      if (claim) return claim;
    }
    return null;
  }

  async claimById(runId: string, processorId: string, options: LeaseQueueOptions): Promise<LeaseClaim | null> {
    const now = this.now();
    const lease = new Date(now.getTime() + options.leaseDurationMs);
    const update = await this.database.query(
      `UPDATE backtest_runs r JOIN backtest_processor_ownership o ON o.singleton_id=1
       SET r.status='running', r.processor_id=?, r.processor_type=?, r.claimed_at=?, r.heartbeat_at=?, r.lease_expires_at=?,
       r.attempt_count=r.attempt_count+1, r.worker_version=?, r.strategy_version=?, r.input_version=?, r.ownership_epoch=?,
       r.current_step='Starting', r.progress_percent=5, r.error=NULL, r.updated_at=?
       WHERE r.run_id=? AND r.status='queued' AND r.cancellation_requested_at IS NULL AND r.attempt_count < r.max_attempts
       AND o.owner=? AND o.epoch=?`,
      [processorId, options.processorType, isoSql(now), isoSql(now), isoSql(lease), options.workerVersion, options.strategyVersion, options.inputVersion, options.ownershipEpoch, isoSql(now), runId, options.processorType, options.ownershipEpoch],
    );
    if ((update.affectedRows ?? 0) !== 1) return null;
    const { rows } = await this.database.query<any>(
      `SELECT run_id, config_json, processor_id, attempt_count, max_attempts, lease_expires_at, ownership_epoch, started_at
       FROM backtest_runs WHERE run_id=? AND status='running' AND processor_id=?`, [runId, processorId],
    );
    if (!rows[0]) return null;
    return {
      runId, processorId, attempt: Number(rows[0].attempt_count), maxAttempts: Number(rows[0].max_attempts),
      leaseExpiresAt: new Date(rows[0].lease_expires_at).toISOString(), ownershipEpoch: Number(rows[0].ownership_epoch), processorType:options.processorType,queueWaitSeconds:Math.max(0,(now.getTime()-new Date(rows[0].started_at).getTime())/1000),
      config: typeof rows[0].config_json === 'string' ? JSON.parse(rows[0].config_json) : rows[0].config_json,
    };
  }

  async heartbeat(runId: string, processorId: string, leaseDurationMs: number, progress: { percent: number; step: string }|undefined=undefined, ownershipEpoch=1, processorType:'monolith'|'service'='monolith'): Promise<boolean> {
    const now = this.now();
    const lease = new Date(now.getTime() + leaseDurationMs);
    const result = await this.database.query(
      `UPDATE backtest_runs r JOIN backtest_processor_ownership o ON o.singleton_id=1 SET r.heartbeat_at=?,r.lease_expires_at=?,r.updated_at=?,r.progress_percent=COALESCE(?,r.progress_percent),r.current_step=COALESCE(?,r.current_step)
       WHERE r.run_id=? AND r.status='running' AND r.processor_id=? AND r.processor_type=? AND r.ownership_epoch=? AND r.lease_expires_at>? AND o.owner=? AND o.epoch=?`,
      [isoSql(now),isoSql(lease),isoSql(now),progress?.percent??null,progress?.step??null,runId,processorId,processorType,ownershipEpoch,isoSql(now),processorType,ownershipEpoch],
    );
    return (result.affectedRows ?? 0) === 1;
  }

  async cancellationRequested(runId: string, processorId: string, ownershipEpoch=1, processorType:'monolith'|'service'='monolith'): Promise<boolean> {
    const { rows } = await this.database.query<any>(
      `SELECT r.cancellation_requested_at FROM backtest_runs r JOIN backtest_processor_ownership o ON o.singleton_id=1 WHERE r.run_id=? AND r.processor_id=? AND r.processor_type=? AND r.status IN ('running','cancel_requested') AND r.ownership_epoch=? AND o.owner=? AND o.epoch=?`,
      [runId,processorId,processorType,ownershipEpoch,processorType,ownershipEpoch],
    );
    return Boolean(rows[0]?.cancellation_requested_at);
  }

  async requestOwnedCancellation(runId: string, userId: number): Promise<UserCancellationResult> {
    return this.requestCancellationInScope(runId, { ownerId: String(userId) });
  }

  async requestAdminCancellation(runId: string): Promise<UserCancellationResult> {
    return this.requestCancellationInScope(runId, { admin: true });
  }

  private async requestCancellationInScope(runId: string, scope: { ownerId: string } | { admin: true }): Promise<UserCancellationResult> {
    const now = isoSql(this.now());
    const ownerSql = 'admin' in scope ? '' : ' AND created_by=?';
    const params = (values: any[]) => 'admin' in scope ? values : [...values, scope.ownerId];
    let result = await this.database.query(
      `UPDATE backtest_runs SET status='cancelled', cancellation_requested_at=?, completed_at=?, current_step='Cancelled', updated_at=?
       WHERE run_id=? AND status='queued'${ownerSql}`, params([now, now, now, runId]),
    );
    if ((result.affectedRows ?? 0) === 1) return { kind: 'cancelled', changed: true };
    result = await this.database.query(
      `UPDATE backtest_runs SET status='cancel_requested', cancellation_requested_at=?, current_step='Cancellation requested', updated_at=?
       WHERE run_id=? AND status='running'${ownerSql}`, params([now, now, runId]),
    );
    if ((result.affectedRows ?? 0) === 1) return { kind: 'cancellation_requested', changed: true };
    const { rows } = await this.database.query<any>(`SELECT status FROM backtest_runs WHERE run_id=?${ownerSql}`, params([runId]));
    if (!rows[0]) return { kind: 'not_found_or_unauthorized', changed: false };
    return { kind: 'not_actionable', changed: false, status: String(rows[0].status) };
  }

  async complete(runId: string, processorId: string, ownershipEpoch=1, processorType:'monolith'|'service'='monolith'): Promise<boolean> {
    const now = isoSql(this.now());
    const result = await this.database.query(
      `UPDATE backtest_runs r JOIN backtest_processor_ownership o ON o.singleton_id=1 SET r.status='completed',r.progress_percent=100,r.current_step='Completed',r.completed_at=?,r.lease_expires_at=NULL,r.heartbeat_at=?,r.updated_at=?,r.error=NULL
       WHERE r.run_id=? AND r.status='running' AND r.processor_id=? AND r.processor_type=? AND r.ownership_epoch=? AND r.lease_expires_at>? AND r.cancellation_requested_at IS NULL AND o.owner=? AND o.epoch=?`,
      [now,now,now,runId,processorId,processorType,ownershipEpoch,now,processorType,ownershipEpoch],
    );
    return (result.affectedRows ?? 0) === 1;
  }

  async markCancelled(runId: string, processorId: string, ownershipEpoch=1, processorType:'monolith'|'service'='monolith'): Promise<boolean> {
    const now = isoSql(this.now());
    const result = await this.database.query(
      `UPDATE backtest_runs r JOIN backtest_processor_ownership o ON o.singleton_id=1 SET r.status='cancelled',r.completed_at=?,r.current_step='Cancelled',r.lease_expires_at=NULL,r.updated_at=?
       WHERE r.run_id=? AND r.status='cancel_requested' AND r.processor_id=? AND r.processor_type=? AND r.ownership_epoch=? AND r.lease_expires_at>? AND o.owner=? AND o.epoch=?`, [now,now,runId,processorId,processorType,ownershipEpoch,now,processorType,ownershipEpoch],
    );
    return (result.affectedRows ?? 0) === 1;
  }

  async fail(runId: string, processorId: string, category: string, error: string, retryable: boolean, ownershipEpoch=1, processorType:'monolith'|'service'='monolith'): Promise<'queued'|'failed'|'dead'|'cancelled'|'lost'> {
    const { rows } = await this.database.query<any>(
      `SELECT r.attempt_count,r.max_attempts,r.status FROM backtest_runs r JOIN backtest_processor_ownership o ON o.singleton_id=1 WHERE r.run_id=? AND r.processor_id=? AND r.processor_type=? AND r.status IN ('running','cancel_requested') AND r.lease_expires_at>? AND r.ownership_epoch=? AND o.owner=? AND o.epoch=?`, [runId,processorId,processorType,isoSql(this.now()),ownershipEpoch,processorType,ownershipEpoch],
    );
    if (!rows[0]) return 'lost';
    const observedStatus = String(rows[0].status);
    const next = observedStatus === 'cancel_requested' ? 'cancelled'
      : retryable && Number(rows[0].attempt_count) < Number(rows[0].max_attempts) ? 'queued' : (retryable ? 'dead' : 'failed');
    const now = isoSql(this.now());
    const result = await this.database.query(
      `UPDATE backtest_runs r JOIN backtest_processor_ownership o ON o.singleton_id=1 SET r.status=?,r.failure_category=?,r.last_error=?,r.error=?,r.processor_id=NULL,r.lease_expires_at=NULL,r.heartbeat_at=NULL,r.completed_at=?,r.current_step=?,r.updated_at=?
       WHERE r.run_id=? AND r.processor_id=? AND r.processor_type=? AND r.status=? AND r.lease_expires_at>? AND r.ownership_epoch=? AND o.owner=? AND o.epoch=?`,
      [next,category,error.slice(0,65000),error.slice(0,65000),next==='queued'?null:now,next==='queued'?'Queued for retry':next==='dead'?'Dead':next==='cancelled'?'Cancelled':'Failed',now,runId,processorId,processorType,observedStatus,now,ownershipEpoch,processorType,ownershipEpoch],
    );
    return (result.affectedRows ?? 0) === 1 ? next : 'lost';
  }

  async recoverStale(): Promise<{ requeued: number; dead: number }> {
    const now = isoSql(this.now());
    await this.database.query(
      `UPDATE backtest_runs SET status='cancelled', processor_id=NULL, lease_expires_at=NULL, completed_at=?,
       failure_category='stale_lease', last_error='Cancellation finalized after expired lease', current_step='Cancelled', updated_at=?
       WHERE status='cancel_requested' AND lease_expires_at<=?`, [now, now, now],
    );
    const requeued = await this.database.query(
      `UPDATE backtest_runs SET status='queued', processor_id=NULL, claimed_at=NULL, heartbeat_at=NULL, lease_expires_at=NULL,
       failure_category='stale_lease', last_error='Recovered expired processor lease', current_step='Queued after stale lease', updated_at=?
       WHERE status='running' AND lease_expires_at<=? AND cancellation_requested_at IS NULL AND attempt_count < max_attempts`, [now, now],
    );
    const dead = await this.database.query(
      `UPDATE backtest_runs SET status='dead', processor_id=NULL, lease_expires_at=NULL, failure_category='attempts_exhausted',
       last_error='Expired lease with attempts exhausted', completed_at=?, current_step='Dead', updated_at=?
       WHERE status='running' AND lease_expires_at<=? AND attempt_count >= max_attempts`, [now, now, now],
    );
    return { requeued: requeued.affectedRows ?? 0, dead: dead.affectedRows ?? 0 };
  }

  async operationalSnapshot(): Promise<{ queued: number; running: number; failed: number; dead: number; oldestQueuedSeconds: number }> {
    const { rows } = await this.database.query<any>(`SELECT
      SUM(status='queued') queued,
      SUM(status IN ('running','cancel_requested')) running,
      SUM(status='failed') failed,
      SUM(status='dead') dead,
      COALESCE(TIMESTAMPDIFF(SECOND, MIN(CASE WHEN status='queued' THEN started_at END), NOW()),0) oldest_queued_seconds
      FROM backtest_runs`);
    const row = rows[0] ?? {};
    return { queued: Number(row.queued ?? 0), running: Number(row.running ?? 0), failed: Number(row.failed ?? 0), dead: Number(row.dead ?? 0), oldestQueuedSeconds: Number(row.oldest_queued_seconds ?? 0) };
  }
  async activeByOwnershipEpoch():Promise<Array<{ownershipEpoch:number;processorType:string;count:number}>>{const{rows}=await this.database.query<any>(`SELECT COALESCE(ownership_epoch,0) ownership_epoch,COALESCE(processor_type,'legacy') processor_type,COUNT(*) count FROM backtest_runs WHERE status IN ('running','cancel_requested') GROUP BY ownership_epoch,processor_type`);return rows.map(row=>({ownershipEpoch:Number(row.ownership_epoch),processorType:String(row.processor_type),count:Number(row.count)}));}
}

export const backtestLeaseQueue = new MysqlBacktestLeaseQueue();
