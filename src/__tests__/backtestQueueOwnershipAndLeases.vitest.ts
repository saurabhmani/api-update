import { afterEach, describe, expect, it } from 'vitest';
import { canTransitionBacktest, assertBacktestTransition } from '@/lib/backtesting/queue/stateMachine';
import { getBacktestProcessorOwner, ownerMayProcess } from '@/lib/backtesting/queue/ownership';
import { MysqlBacktestLeaseQueue, type QueueDb } from '@/lib/backtesting/queue/leaseQueue';
import { loadBacktestWorkerConfig, serviceMayClaimJobs } from '../../services/backtest-worker/src/config';
import { BacktestWorker } from '../../services/backtest-worker/src/worker';

class ClaimDb implements QueueDb {
  row: any = { run_id: 'run-1', status: 'queued', config_json: '{}', attempt_count: 0, max_attempts: 3 };
  async query<T = any>(sql: string, params: any[] = []): Promise<{ rows: T[]; affectedRows?: number }> {
    if (sql.includes('UPDATE backtest_runs r JOIN')) {
      if (this.row.status !== 'queued') return { rows: [], affectedRows: 0 };
      this.row = { ...this.row, status: 'running', processor_id: params[0], processor_type:params[1], lease_expires_at: params[4], ownership_epoch:params[9], attempt_count: 1 };
      return { rows: [], affectedRows: 1 };
    }
    if (sql.includes('SELECT run_id, config_json')) return { rows: [this.row] as T[] };
    if (sql.includes('SELECT run_id FROM')) return { rows: this.row.status === 'queued' ? [{ run_id: this.row.run_id }] as T[] : [] };
    return { rows: [], affectedRows: 0 };
  }
}

afterEach(() => { delete process.env.BACKTEST_PROCESSOR_OWNER; });
describe('Backtest state machine', () => {
  it('accepts legal transitions and rejects illegal terminal transitions', () => {
    expect(canTransitionBacktest('queued', 'running')).toBe(true);
    expect(canTransitionBacktest('running', 'queued')).toBe(true);
    expect(() => assertBacktestTransition('completed', 'running')).toThrow(/Invalid backtest transition/);
  });
});
describe('atomic lease claim', () => {
  it('allows exactly one processor to win and increments once', async () => {
    const db = new ClaimDb(); const queue = new MysqlBacktestLeaseQueue(db, () => new Date('2026-01-01T00:00:00Z'));
    const options = { leaseDurationMs: 60_000, workerVersion: 'test', strategyVersion: '1', inputVersion: '1', ownershipEpoch:1, processorType:'service' as const };
    const [a, b] = await Promise.all([queue.claimById('run-1', 'worker-a', options), queue.claimById('run-1', 'worker-b', options)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(db.row.attempt_count).toBe(1);
    expect(db.row.processor_id).toBe(a?.processorId ?? b?.processorId);
  });
});
describe('ownership and worker configuration', () => {
  it('defaults to monolith and denies the service', () => {
    expect(getBacktestProcessorOwner({} as NodeJS.ProcessEnv)).toBe('monolith');
    expect(ownerMayProcess('monolith', {} as NodeJS.ProcessEnv)).toBe(true);
    const config = loadBacktestWorkerConfig({} as NodeJS.ProcessEnv);
    expect(serviceMayClaimJobs(config)).toBe(false);
  });
  it('accepts explicit service ownership and rejects unsafe combinations', () => {
    expect(serviceMayClaimJobs(loadBacktestWorkerConfig({ NODE_ENV: 'test', BACKTEST_PROCESSOR_OWNER: 'service', BACKTEST_WORKER_ENABLED: 'true' }))).toBe(true);
    expect(() => loadBacktestWorkerConfig({ NODE_ENV: 'test', BACKTEST_PROCESSOR_OWNER: 'service' })).toThrow();
    expect(() => loadBacktestWorkerConfig({ NODE_ENV: 'test', BACKTEST_WORKER_ENABLED: 'true' })).toThrow();
    expect(() => loadBacktestWorkerConfig({ NODE_ENV: 'test', BACKTEST_PROCESSOR_OWNER: 'service', BACKTEST_WORKER_ENABLED: 'true', BACKTEST_WORKER_HEARTBEAT_INTERVAL_MS: '1000', BACKTEST_WORKER_LEASE_DURATION_MS: '2000' })).toThrow(/3x/);
  });
});
describe('worker lifecycle', () => {
  it('reports ready only in explicit service mode and shuts down without new claims', async () => {
    let claims = 0;
    const queue = { operationalSnapshot: async () => ({ queued:0,running:0,failed:0,dead:0,oldestQueuedSeconds:0 }), activeByOwnershipEpoch:async()=>[], claimNext: async () => { claims++; return null; }, recoverStale: async () => ({ requeued:0,dead:0 }) };
    const config = loadBacktestWorkerConfig({ NODE_ENV:'test', BACKTEST_PROCESSOR_OWNER:'service', BACKTEST_WORKER_ENABLED:'true', BACKTEST_WORKER_POLL_INTERVAL_MS:'10000', BACKTEST_WORKER_RECOVERY_INTERVAL_MS:'10000' });
    const authority={refresh:async()=>({allowed:true,reason:'authorized',authoritativeEpoch:1,authoritativeOwner:'service'}),snapshot:()=>({lastAuthorityRefreshSuccess:new Date().toISOString()})};
    const worker = new BacktestWorker(config, queue as any, undefined, authority as any); expect(worker.ready).toBe(false); worker.start();
    await new Promise(resolve => setTimeout(resolve, 5)); await worker.stop();
    expect(worker.ready).toBe(false); expect(claims).toBe(1);
  });
});
