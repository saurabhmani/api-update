import { STRATEGY_ENGINE_VERSION } from '@strategy-engine';
import { backtestLeaseQueue, type LeaseClaim, type MysqlBacktestLeaseQueue } from '@/lib/backtesting/queue/leaseQueue';
import { processBacktestClaim } from '@/lib/backtesting/queue/processor';
import type { BacktestWorkerConfig } from './config';
import { BacktestWorkerMetrics } from './metrics';
import { ProcessorAuthorityRuntime } from '@/lib/backtesting/queue/processorAuthorityRuntime';

export class BacktestWorker {
  private stopping = false; private timer?: NodeJS.Timeout; private recoveryTimer?: NodeJS.Timeout;
  private active = new Map<string, AbortController>();
  private authority:ProcessorAuthorityRuntime; private authorityAllowed=false; private authorityEpoch?:number; private authorityReason='authority-unavailable';
  private lastMetricReason?:string;
  constructor(readonly config: BacktestWorkerConfig, private queue: MysqlBacktestLeaseQueue = backtestLeaseQueue, readonly metrics = new BacktestWorkerMetrics(), authority?:ProcessorAuthorityRuntime) { this.authority=authority??new ProcessorAuthorityRuntime({processorType:'service',configuredOwner:config.owner,configuredEpoch:config.ownershipEpoch,workerEnabled:config.enabled,applicationVersion:process.env.APP_VERSION??'unknown',workerVersion:config.workerVersion,processorId:config.processorId}); }
  get ready() { return !this.stopping && this.authorityAllowed; }
  readiness(){return{healthy:true,ready:this.ready,reason:this.authorityReason,configuredOwner:this.config.owner,configuredEpoch:this.config.ownershipEpoch,authoritativeEpoch:this.authorityEpoch,processorType:'service',processorId:this.config.processorId,workerEnabled:this.config.enabled,...this.authority.snapshot()};}
  private async refreshAuthority(){const decision=await this.authority.refresh();this.authorityAllowed=decision.allowed;this.authorityEpoch=decision.authoritativeEpoch;this.authorityReason=decision.reason;this.metrics.set('worker_readiness',this.ready?1:0);this.metrics.set('configured_owner',this.config.owner==='service'?1:this.config.owner==='monolith'?0:-1);this.metrics.set('authoritative_owner',decision.authoritativeOwner==='service'?1:decision.authoritativeOwner==='monolith'?0:-1);this.metrics.set('ownership_epoch',decision.authoritativeEpoch??0);this.metrics.set('configured_epoch',this.config.ownershipEpoch??0);this.metrics.set('last_authority_refresh_seconds',Math.floor(Date.now()/1000));if(this.lastMetricReason!==decision.reason){if(decision.reason==='owner-mismatch')this.metrics.inc('owner_mismatch_total');if(decision.reason==='epoch-mismatch')this.metrics.inc('epoch_mismatch_total');this.lastMetricReason=decision.reason}return decision;}
  start() {
    this.metrics.set('worker_readiness', 0); this.metrics.set('worker_ownership_mode', this.config.owner==='service'?1:0);
    this.metrics.set('worker_enabled',this.config.enabled?1:0);this.metrics.set('claim_conflicts_total',0);this.metrics.set('duplicate_claims_total',0);this.metrics.set('heartbeat_failures_total',0);this.metrics.set('mysql_failures_total',0);this.metrics.set('mysql_pool_utilization',0);this.metrics.set('persisted_parity_ok',0);this.metrics.set('authorization_denials_total',0);this.metrics.set('admin_destructive_actions_total',0);
    void this.poll(); this.timer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
    this.recoveryTimer = setInterval(() => void this.recover(), this.config.recoveryIntervalMs);
  }
  private async poll() { try {
    const authority=await this.refreshAuthority(); if (!authority.allowed||authority.authoritativeEpoch==null) return;
    const snapshot = await this.queue.operationalSnapshot();
    for(const group of await this.queue.activeByOwnershipEpoch())this.metrics.set(`active_runs_epoch_${group.ownershipEpoch}`,group.count);
    this.metrics.set('queue_depth', snapshot.queued); this.metrics.set('oldest_queued_age_seconds', snapshot.oldestQueuedSeconds);
    this.metrics.set('failed_jobs', snapshot.failed); this.metrics.set('dead_jobs', snapshot.dead);
    while (this.active.size < this.config.maxConcurrency) {
      const claim = await this.queue.claimNext(this.config.processorId, { leaseDurationMs: this.config.leaseDurationMs, workerVersion: this.config.workerVersion, strategyVersion: STRATEGY_ENGINE_VERSION.contractVersion, inputVersion: '1', ownershipEpoch: authority.authoritativeEpoch, processorType:'service' });
      if (!claim) break;
      this.metrics.inc('claims_total'); this.metrics.inc(`claims_epoch_${claim.ownershipEpoch}_total`);this.metrics.set('queue_wait_seconds',claim.queueWaitSeconds??0); this.metrics.set('running_jobs', this.active.size + 1);
      this.run(claim);
    }
  }catch(error){this.metrics.inc('mysql_failures_total');console.error(JSON.stringify({event:'backtest_worker_poll_failed',processorId:this.config.processorId,error:error instanceof Error?error.message:String(error),timestamp:new Date().toISOString()}));}}
  private run(claim: LeaseClaim) {
    const started=Date.now();
    const controller = new AbortController(); this.active.set(claim.runId, controller);
    const heartbeat = setInterval(async () => {
      if (!await this.queue.heartbeat(claim.runId, claim.processorId, this.config.leaseDurationMs, undefined, claim.ownershipEpoch, claim.processorType)) {
        this.metrics.inc('lost_leases_total');this.metrics.inc('heartbeat_failures_total'); this.metrics.inc('stale_epoch_rejections_total'); console.warn(JSON.stringify({event:'backtest_stale_epoch_rejection',operation:'heartbeat',jobId:claim.runId,processorId:claim.processorId,claimedEpoch:claim.ownershipEpoch,timestamp:new Date().toISOString()})); controller.abort();
      } else this.metrics.inc('lease_extensions_total');
    }, this.config.heartbeatIntervalMs);
    void processBacktestClaim(claim, this.queue, this.config.leaseDurationMs, controller.signal).then(state => {
      this.metrics.inc(`${state}_jobs_total`);
      console.info(JSON.stringify({ event: 'backtest_transition', jobId: claim.runId, processorId: claim.processorId, attempt: claim.attempt, state, workerVersion: this.config.workerVersion }));
    }).finally(() => { clearInterval(heartbeat);this.metrics.set('processing_duration_seconds',(Date.now()-started)/1000); this.active.delete(claim.runId); this.metrics.set('running_jobs', this.active.size); });
  }
  private async recover() { if(!(await this.refreshAuthority()).allowed)return; const result = await this.queue.recoverStale(); this.metrics.inc('stale_recoveries_total', result.requeued + result.dead); }
  async stop() {
    this.stopping = true; this.metrics.set('worker_readiness', 0);
    if (this.timer) clearInterval(this.timer); if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    for (const controller of this.active.values()) controller.abort();
    while (this.active.size) await new Promise(resolve => setTimeout(resolve, 10));
  }
}
