import mysql, { type Pool } from 'mysql2/promise';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { MysqlBacktestLeaseQueue, type QueueDb } from '@/lib/backtesting/queue/leaseQueue';
import { resetAndMigrate } from '../../scripts/backtestIntegrationDb';
import { runBacktestQueuePreflight } from '../../scripts/backtestQueuePreflight';
import { ownerMayProcess } from '@/lib/backtesting/queue/ownership';
import { MysqlBacktestOwnershipAuthority } from '@/lib/backtesting/queue/ownershipAuthority';
import { deleteBacktestForActor, getBacktestForActor, listBacktestsForActor } from '@/lib/backtesting/authorization/resourceAuthorization';

const enabled = process.env.BACKTEST_MYSQL_INTEGRATION === 'true';
const suite = enabled ? describe : describe.skip;
const cfg = { host: process.env.BACKTEST_IT_DB_HOST ?? '127.0.0.1', port: Number(process.env.BACKTEST_IT_DB_PORT ?? 33316), user: process.env.BACKTEST_IT_DB_USER ?? 'backtest_it', password: process.env.BACKTEST_IT_DB_PASSWORD ?? 'integration-only', database: process.env.BACKTEST_IT_DB_NAME ?? 'quantorus_backtest_it', connectionLimit: 8, dateStrings: true };
let poolA: Pool; let poolB: Pool;
const adapter = (pool: Pool): QueueDb => ({ async query<T>(sql: string, params: any[] = []) { const [value]: any = await pool.query(sql, params); return Array.isArray(value) ? { rows: value as T[] } : { rows: [], affectedRows: value.affectedRows }; } });
const options = { leaseDurationMs: 60_000, workerVersion: 'it-worker', strategyVersion: '1.0.0', inputVersion: 'fixture-v1', ownershipEpoch:1, processorType:'monolith' as const };
async function seed(id: string, status = 'queued', attempts = 0, maxAttempts = 3, owner: string | null = null) { await poolA.query(`INSERT INTO backtest_runs (run_id,name,config_json,status,started_at,attempt_count,max_attempts,created_by) VALUES (?,?,'{}',?,NOW(3),?,?,?)`, [id, id, status, attempts, maxAttempts, owner]); }

suite('Backtest queue live MySQL integration', () => {
  beforeAll(async () => {
    process.env.MYSQL_HOST=cfg.host; process.env.MYSQL_PORT=String(cfg.port); process.env.MYSQL_USER=cfg.user; process.env.MYSQL_PASSWORD=cfg.password; process.env.MYSQL_DATABASE=cfg.database;
    await resetAndMigrate(); poolA = mysql.createPool(cfg); poolB = mysql.createPool(cfg);
  });
  beforeEach(async () => { await poolA.query('DELETE FROM backtest_runs'); await poolA.query(`UPDATE backtest_processor_ownership SET owner='monolith',epoch=1,updated_at=NOW(3),updated_by='integration-reset' WHERE singleton_id=1`); });
  afterAll(async () => { await poolA?.end(); await poolB?.end(); });

  it('migration and runtime contract agree on columns, defaults, and claim indexes', async () => {
    const [columns]: any = await poolA.query(`SELECT column_name,column_default,is_nullable FROM information_schema.columns WHERE table_schema=? AND table_name='backtest_runs'`, [cfg.database]);
    const names = new Set(columns.map((row: any) => row.COLUMN_NAME ?? row.column_name));
    for (const name of ['processor_id','processor_type','claimed_at','heartbeat_at','lease_expires_at','attempt_count','max_attempts','cancellation_requested_at','failure_category','last_error','idempotency_key','worker_version','input_version','strategy_version','ownership_epoch','updated_at']) expect(names.has(name)).toBe(true);
    const [indexes]: any = await poolA.query(`SELECT DISTINCT index_name FROM information_schema.statistics WHERE table_schema=? AND table_name='backtest_runs'`, [cfg.database]);
    expect(indexes.map((row: any) => row.INDEX_NAME ?? row.index_name)).toEqual(expect.arrayContaining(['idx_br_claimable','idx_br_processor_lease','idx_br_idempotency']));
  });

  it('enforces live ownership transitions and epoch-scoped acknowledgement', async () => {
    const authority = new MysqlBacktestOwnershipAuthority(adapter(poolA));
    const initial = await authority.read(); expect(initial).toMatchObject({ owner:'monolith', epoch:1 });
    await expect(authority.transition(1,'service','it-operator',false)).rejects.toThrow('disabled');
    expect(await authority.transition(1,'disabled','it-operator',false)).toMatchObject({ owner:'disabled', epoch:2 });
    expect(await authority.transition(2,'service','it-operator',false)).toMatchObject({ owner:'service', epoch:3 });
    await seed('epoch-claim'); const queue = new MysqlBacktestLeaseQueue(adapter(poolA));
    const claim = await queue.claimById('epoch-claim','service-processor',{...options,ownershipEpoch:3,processorType:'service'}); expect(claim?.ownershipEpoch).toBe(3);
    expect(await queue.complete('epoch-claim','service-processor',2,'service')).toBe(false);
    expect(await queue.complete('epoch-claim','service-processor',3,'service')).toBe(true);
  });

  it('preflight passes clean data and blocks controlled invalid fixtures without mutation', async () => {
    await seed('legacy-queued');
    await poolA.query(`INSERT INTO backtest_runs (run_id,name,config_json,status,started_at,completed_at) VALUES ('legacy-complete','legacy','{}','completed',NOW(),NOW()),('legacy-failed','legacy','{}','failed',NOW(),NOW())`);
    expect((await runBacktestQueuePreflight(adapter(poolA), cfg.database)).ok).toBe(true);
    await poolA.query(`INSERT INTO backtest_runs (run_id,name,config_json,status,started_at,idempotency_key) VALUES ('bad-1','bad','{}','invalid_fixture',NOW(),'duplicate'),('bad-2','bad','{}','queued',NOW(),'duplicate')`);
    const blocked = await runBacktestQueuePreflight(adapter(poolA), cfg.database);
    expect(blocked.ok).toBe(false); expect(blocked.report.invalidStatuses).toBe(1); expect(blocked.report.duplicateIdempotencyValues).toBe(1);
    const [rows]: any = await poolA.query(`SELECT status FROM backtest_runs WHERE run_id='bad-1'`); expect(rows[0].status).toBe('invalid_fixture');
  });

  it('allows exactly one winner across independent pools and releases locks', async () => {
    for (let index = 0; index < 10; index++) {
      const id = `race-${index}`; await seed(id);
      const a = new MysqlBacktestLeaseQueue(adapter(poolA)); const b = new MysqlBacktestLeaseQueue(adapter(poolB));
      const claims = await Promise.all([a.claimById(id, 'processor-a', options), b.claimById(id, 'processor-b', options)]);
      expect(claims.filter(Boolean)).toHaveLength(1);
      const [rows]: any = await poolA.query('SELECT * FROM backtest_runs WHERE run_id=?', [id]);
      expect(rows[0].attempt_count).toBe(1); expect(rows[0].processor_id).toBe(claims.find(Boolean)?.processorId);
      expect(rows[0].claimed_at).toBeTruthy(); expect(rows[0].heartbeat_at).toBeTruthy(); expect(rows[0].lease_expires_at).toBeTruthy();
    }
    await poolB.query(`SET SESSION innodb_lock_wait_timeout=1`);
    await poolB.query(`UPDATE backtest_runs SET current_step='lock-check' WHERE run_id='race-9'`);
  });

  it('authorizes current-epoch monolith/service claims and blocks stale, disabled, and raced claims', async()=>{
    const queue=new MysqlBacktestLeaseQueue(adapter(poolA)); await seed('mono-current');
    const mono=await queue.claimById('mono-current','mono',{...options,processorType:'monolith',ownershipEpoch:1});expect(mono).toMatchObject({processorType:'monolith',ownershipEpoch:1,attempt:1});
    await seed('mono-stale');expect(await queue.claimById('mono-stale','mono',{...options,processorType:'monolith',ownershipEpoch:2})).toBeNull();
    const authority=new MysqlBacktestOwnershipAuthority(adapter(poolA));expect((await authority.transition(1,'disabled','operator',false)).epoch).toBe(2);
    await seed('disabled-mono');await seed('disabled-service');expect(await queue.claimById('disabled-mono','mono',{...options,processorType:'monolith',ownershipEpoch:2})).toBeNull();expect(await queue.claimById('disabled-service','service',{...options,processorType:'service',ownershipEpoch:2})).toBeNull();
    await poolA.query(`UPDATE backtest_runs SET lease_expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE run_id='mono-current'`);await queue.recoverStale();expect((await authority.transition(2,'service','operator',false)).epoch).toBe(3);
    await seed('service-current');const service=await queue.claimById('service-current','service',{...options,processorType:'service',ownershipEpoch:3});expect(service).toMatchObject({processorType:'service',ownershipEpoch:3});await seed('service-stale');expect(await queue.claimById('service-stale','service',{...options,processorType:'service',ownershipEpoch:2})).toBeNull();
    await poolA.query(`UPDATE backtest_processor_ownership SET owner='monolith',epoch=10,updated_by='race',updated_at=NOW(3) WHERE singleton_id=1`);await seed('authority-race');const [,claim]=await Promise.all([poolB.query(`UPDATE backtest_processor_ownership SET owner='disabled',epoch=11,updated_by='race',updated_at=NOW(3) WHERE singleton_id=1 AND epoch=10`),queue.claimById('authority-race','mono',{...options,processorType:'monolith',ownershipEpoch:10})]);const [row]:any=await poolA.query(`SELECT status,ownership_epoch FROM backtest_runs WHERE run_id='authority-race'`);expect(claim===null||row[0].status==='running').toBe(true);expect(await queue.complete('authority-race','mono',10,'monolith')).toBe(false);
  });

  it.each(['monolith','service'] as const)('enforces current authority on %s lifecycle acknowledgements',async processorType=>{
    const authority=new MysqlBacktestOwnershipAuthority(adapter(poolA));let epoch=1;if(processorType==='service'){await authority.transition(1,'disabled','op',false);await authority.transition(2,'service','op',false);epoch=3}const queue=new MysqlBacktestLeaseQueue(adapter(poolA));await seed(`${processorType}-life`);expect(await queue.claimById(`${processorType}-life`,processorType,{...options,processorType,ownershipEpoch:epoch})).toBeTruthy();expect(await queue.heartbeat(`${processorType}-life`,processorType,60000,undefined,epoch,processorType)).toBe(true);expect(await queue.heartbeat(`${processorType}-life`,'foreign',60000,undefined,epoch,processorType)).toBe(false);await poolA.query(`UPDATE backtest_processor_ownership SET owner='disabled',epoch=? WHERE singleton_id=1`,[epoch+1]);expect(await queue.heartbeat(`${processorType}-life`,processorType,60000,undefined,epoch,processorType)).toBe(false);expect(await queue.complete(`${processorType}-life`,processorType,epoch,processorType)).toBe(false);expect(await queue.fail(`${processorType}-life`,processorType,'stale','stale',true,epoch,processorType)).toBe('lost');await poolA.query(`UPDATE backtest_runs SET status='cancel_requested',cancellation_requested_at=NOW(3) WHERE run_id=?`,[`${processorType}-life`]);expect(await queue.markCancelled(`${processorType}-life`,processorType,epoch,processorType)).toBe(false);
  });

  it('distributes eligible jobs without claiming cancelled or exhausted work', async () => {
    await Promise.all([seed('job-1'), seed('job-2'), seed('cancelled','cancelled'), seed('exhausted','queued',3,3)]);
    const a = new MysqlBacktestLeaseQueue(adapter(poolA)); const b = new MysqlBacktestLeaseQueue(adapter(poolB));
    const claims = await Promise.all([a.claimNext('processor-a', options), b.claimNext('processor-b', options)]);
    expect(new Set(claims.map(claim => claim?.runId))).toEqual(new Set(['job-1','job-2']));
  });

  it('enforces heartbeat and finalization ownership including lease loss', async () => {
    await seed('lease');
    const now = new Date('2026-01-01T00:00:00Z'); const queue = new MysqlBacktestLeaseQueue(adapter(poolA), () => now);
    expect(await queue.claimById('lease','owner',options)).toBeTruthy();
    expect(await queue.heartbeat('lease','foreign',60_000)).toBe(false);
    expect(await queue.heartbeat('lease','owner',60_000)).toBe(true);
    await poolA.query(`UPDATE backtest_runs SET lease_expires_at='2025-12-31 23:59:59.000' WHERE run_id='lease'`);
    expect(await queue.complete('lease','owner')).toBe(false);
    expect(await queue.fail('lease','owner','late','late failure',true)).toBe('lost');
    expect(await queue.markCancelled('lease','owner')).toBe(false);
  });

  it('recovers stale work idempotently and preserves attempts', async () => {
    await seed('retry','running',1,3); await seed('dead','running',3,3); await seed('cancel','cancel_requested',1,3); await seed('active','running',1,3);
    await poolA.query(`UPDATE backtest_runs SET processor_id='old', claimed_at=NOW(3), heartbeat_at=NOW(3), lease_expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE run_id IN ('retry','dead','cancel')`);
    await poolA.query(`UPDATE backtest_runs SET processor_id='live', claimed_at=NOW(3), heartbeat_at=NOW(3), lease_expires_at=DATE_ADD(NOW(3),INTERVAL 1 HOUR) WHERE run_id='active'`);
    const queue = new MysqlBacktestLeaseQueue(adapter(poolA)); const first = await queue.recoverStale(); const second = await queue.recoverStale();
    expect(first).toEqual({ requeued: 1, dead: 1 }); expect(second).toEqual({ requeued: 0, dead: 0 });
    const [rows]: any = await poolA.query('SELECT run_id,status,attempt_count,processor_id FROM backtest_runs');
    const byId = Object.fromEntries(rows.map((row: any) => [row.run_id,row]));
    expect(byId.retry).toMatchObject({ status:'queued', attempt_count:1, processor_id:null });
    expect(byId.dead.status).toBe('dead'); expect(byId.cancel.status).toBe('cancelled'); expect(byId.active.status).toBe('running');
  });

  it('supports queued and cooperative running cancellation without completion', async () => {
    await seed('queued-cancel'); await seed('running-cancel');
    const queue = new MysqlBacktestLeaseQueue(adapter(poolA));
    expect(await queue.requestAdminCancellation('queued-cancel')).toMatchObject({ changed:true,kind:'cancelled' });
    expect(await queue.claimById('queued-cancel','owner',options)).toBeNull();
    expect(await queue.claimById('running-cancel','owner',options)).toBeTruthy();
    expect(await queue.requestAdminCancellation('running-cancel')).toMatchObject({ changed:true,kind:'cancellation_requested' });
    expect(await queue.cancellationRequested('running-cancel','owner')).toBe(true);
    expect(await queue.complete('running-cancel','owner')).toBe(false);
    expect(await queue.markCancelled('running-cancel','owner')).toBe(true);
  });

  it('atomically enforces owner, admin, ownerless, terminal, and non-enumerating cancellation policy', async () => {
    const queue = new MysqlBacktestLeaseQueue(adapter(poolA));
    await seed('owned-queued','queued',0,3,'101'); await seed('owned-running','queued',0,3,'101'); await seed('other','queued',0,3,'202'); await seed('ownerless','queued');
    await seed('completed','completed',0,3,'101'); await poolA.query(`UPDATE backtest_runs SET completed_at=NOW() WHERE run_id='completed'`);
    expect(await queue.requestOwnedCancellation('owned-queued',101)).toMatchObject({ kind:'cancelled',changed:true });
    expect(await queue.claimById('owned-running','processor',options)).toBeTruthy();
    expect(await queue.requestOwnedCancellation('owned-running',101)).toMatchObject({ kind:'cancellation_requested',changed:true });
    const denied = await queue.requestOwnedCancellation('other',101); const absent = await queue.requestOwnedCancellation('missing',101);
    expect(denied).toEqual(absent); expect(denied.kind).toBe('not_found_or_unauthorized');
    expect((await queue.requestOwnedCancellation('ownerless',101)).kind).toBe('not_found_or_unauthorized');
    expect(await queue.requestAdminCancellation('ownerless')).toMatchObject({ kind:'cancelled',changed:true });
    expect(await queue.requestOwnedCancellation('completed',101)).toMatchObject({ kind:'not_actionable',status:'completed' });
    const [rows]: any = await poolA.query(`SELECT run_id,status,attempt_count,processor_id,cancellation_requested_at FROM backtest_runs WHERE run_id IN ('owned-running','other') ORDER BY run_id`);
    expect(rows.find((row:any)=>row.run_id==='other')).toMatchObject({ status:'queued',attempt_count:0,processor_id:null,cancellation_requested_at:null });
    expect(rows.find((row:any)=>row.run_id==='owned-running')).toMatchObject({ status:'cancel_requested',attempt_count:1,processor_id:'processor' });
  });

  it('defines cancel-versus-claim, completion, failure, and recovery races', async () => {
    const a = new MysqlBacktestLeaseQueue(adapter(poolA)); const b = new MysqlBacktestLeaseQueue(adapter(poolB));
    await seed('claim-race','queued',0,3,'101');
    const [cancel, claim] = await Promise.all([a.requestOwnedCancellation('claim-race',101), b.claimById('claim-race','processor',options)]);
    const [claimRows]: any = await poolA.query(`SELECT status,attempt_count,processor_id FROM backtest_runs WHERE run_id='claim-race'`);
    expect(['cancelled','cancel_requested']).toContain(claimRows[0].status);
    expect(claimRows[0].status === 'cancelled' ? claim : cancel.kind).toEqual(claimRows[0].status === 'cancelled' ? null : 'cancellation_requested');

    await seed('complete-race','queued',0,3,'101'); expect(await a.claimById('complete-race','processor',options)).toBeTruthy();
    await Promise.all([a.requestOwnedCancellation('complete-race',101), b.complete('complete-race','processor')]);
    const [completeRows]: any = await poolA.query(`SELECT status FROM backtest_runs WHERE run_id='complete-race'`); expect(['completed','cancel_requested']).toContain(completeRows[0].status);

    await seed('failure-race','queued',0,3,'101'); expect(await a.claimById('failure-race','processor',options)).toBeTruthy();
    await a.requestOwnedCancellation('failure-race',101); expect(await b.fail('failure-race','processor','test','failure',true)).toBe('cancelled');

    await seed('recovery-race','queued',0,3,'101'); expect(await a.claimById('recovery-race','processor',options)).toBeTruthy(); await a.requestOwnedCancellation('recovery-race',101);
    await poolA.query(`UPDATE backtest_runs SET lease_expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE run_id='recovery-race'`); await b.recoverStale();
    const [recoveryRows]: any = await poolA.query(`SELECT status,attempt_count FROM backtest_runs WHERE run_id='recovery-race'`); expect(recoveryRows[0]).toMatchObject({ status:'cancelled',attempt_count:1 });
  });

  it('rehearses monolith-service handoff and crash rollback through disabled', async () => {
    const queue = new MysqlBacktestLeaseQueue(adapter(poolA)); const env = { NODE_ENV:'test', BACKTEST_PROCESSOR_OWNER:'monolith' } as NodeJS.ProcessEnv;
    await seed('monolith-job'); expect(ownerMayProcess('monolith', env)).toBe(true); expect(ownerMayProcess('service', env)).toBe(false);
    expect(await queue.claimById('monolith-job','monolith',options)).toBeTruthy();
    await poolA.query(`UPDATE backtest_runs SET status='completed',completed_at=NOW(),lease_expires_at=NULL WHERE run_id='monolith-job'`);
    await seed('service-job'); env.BACKTEST_PROCESSOR_OWNER='disabled';
    expect(ownerMayProcess('monolith',env)).toBe(false); expect(ownerMayProcess('service',env)).toBe(false);
    env.BACKTEST_PROCESSOR_OWNER='service'; expect(ownerMayProcess('monolith',env)).toBe(false); expect(ownerMayProcess('service',env)).toBe(true);
    expect(await queue.claimById('service-job','service',options)).toBeTruthy();
    await poolA.query(`UPDATE backtest_runs SET lease_expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE run_id='service-job'`);
    env.BACKTEST_PROCESSOR_OWNER='disabled'; expect(await queue.recoverStale()).toEqual({ requeued:1,dead:0 });
    env.BACKTEST_PROCESSOR_OWNER='monolith'; expect(ownerMayProcess('service',env)).toBe(false);
    const reclaimed = await queue.claimById('service-job','monolith',options); expect(reclaimed?.attempt).toBe(2);
    const [duplicates]: any = await poolA.query(`SELECT run_id,COUNT(*) count FROM backtest_runs GROUP BY run_id HAVING COUNT(*)>1`); expect(duplicates).toHaveLength(0);
  });

  it('scopes list/detail and ownerless visibility for users and administrators', async () => {
    await seed('user-1','completed',0,3,'101'); await seed('user-2','completed',0,3,'202'); await seed('legacy','completed');
    const user = { kind:'user',userId:101 } as const; const adminActor = { kind:'admin',userId:1 } as const;
    expect((await listBacktestsForActor(user)).map(row=>row.run_id)).toEqual(['user-1']);
    expect(new Set((await listBacktestsForActor(adminActor)).map(row=>row.run_id))).toEqual(new Set(['user-1','user-2','legacy']));
    expect(await getBacktestForActor('user-2',user)).toBeNull(); expect(await getBacktestForActor('missing',user)).toBeNull(); expect(await getBacktestForActor('legacy',user)).toBeNull();
    expect(await getBacktestForActor('legacy',adminActor)).toMatchObject({ run_id:'legacy',created_by:null });
  });

  it('deletes only scoped terminal runs transactionally without orphaned artifacts', async () => {
    await seed('terminal','completed',0,3,'101'); await seed('foreign','completed',0,3,'202'); await seed('active','running',1,3,'101');
    for (const table of ['backtest_trades','backtest_signals','backtest_signal_outcomes','backtest_metrics','backtest_equity_curve','backtest_audit_logs','calibration_snapshots','backtest_performance_metrics','backtest_news_analytics','backtest_news_effectiveness','backtest_summary']) await poolA.query(`INSERT INTO ${table}(run_id,payload) VALUES ('terminal','x')`);
    const user = { kind:'user',userId:101 } as const;
    expect(await deleteBacktestForActor('foreign',user)).toBe('not_found_or_unauthorized');
    expect(await deleteBacktestForActor('missing',user)).toBe('not_found_or_unauthorized');
    expect(await deleteBacktestForActor('active',user)).toBe('active_not_deletable');
    expect(await deleteBacktestForActor('terminal',user)).toBe('deleted');
    for (const table of ['backtest_runs','backtest_trades','backtest_signals','backtest_signal_outcomes','backtest_metrics','backtest_equity_curve','backtest_audit_logs','calibration_snapshots','backtest_performance_metrics','backtest_news_analytics','backtest_news_effectiveness','backtest_summary']) {
      const [rows]:any=await poolA.query(`SELECT COUNT(*) count FROM ${table} WHERE run_id='terminal'`); expect(Number(rows[0].count)).toBe(0);
    }
  });

  it('keeps delete races legal against claim, cancellation, and completion', async () => {
    const queue = new MysqlBacktestLeaseQueue(adapter(poolA)); const user={ kind:'user',userId:101 } as const;
    await seed('claim-delete','queued',0,3,'101'); const [deletion,claim]=await Promise.all([deleteBacktestForActor('claim-delete',user),queue.claimById('claim-delete','processor',options)]);
    expect(deletion).toBe('active_not_deletable'); expect(claim).toBeTruthy();
    await seed('cancel-delete','cancelled',0,3,'101'); const results=await Promise.all([deleteBacktestForActor('cancel-delete',user),queue.requestOwnedCancellation('cancel-delete',101)]);
    expect(results[0]).toBe('deleted'); expect(['not_actionable','not_found_or_unauthorized']).toContain(results[1].kind);
    await seed('complete-delete','queued',0,3,'101'); expect(await queue.claimById('complete-delete','processor',options)).toBeTruthy();
    const [whileRunning,completed]=await Promise.all([deleteBacktestForActor('complete-delete',user),queue.complete('complete-delete','processor')]);
    expect(['active_not_deletable','deleted']).toContain(whileRunning); expect(completed).toBe(true);
    const [finalRows]:any=await poolA.query(`SELECT status FROM backtest_runs WHERE run_id='complete-delete'`);
    if(whileRunning==='deleted') expect(finalRows).toHaveLength(0); else expect(finalRows[0].status).toBe('completed');
  });
});
