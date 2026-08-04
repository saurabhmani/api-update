import { describe, it, expect } from 'vitest';
import { BacktestWorker } from '../../services/backtest-worker/src/worker';
import { loadBacktestWorkerConfig } from '../../services/backtest-worker/src/config';
const config=()=>loadBacktestWorkerConfig({NODE_ENV:'test',BACKTEST_PROCESSOR_OWNER:'service',BACKTEST_WORKER_ENABLED:'true',BACKTEST_WORKER_POLL_INTERVAL_MS:'10000',BACKTEST_WORKER_RECOVERY_INTERVAL_MS:'10000'} as NodeJS.ProcessEnv);
describe('Backtest ownership readiness',()=>{it('tracks shared-authority transitions without claiming while disabled or drifted',async()=>{
  let decision:any={allowed:false,reason:'owner-disabled',authoritativeOwner:'disabled',authoritativeEpoch:2};let claims=0;
  const authority={refresh:async()=>decision,snapshot:()=>({})};
  const queue={operationalSnapshot:async()=>({queued:0,running:0,failed:0,dead:0,oldestQueuedSeconds:0}),activeByOwnershipEpoch:async()=>[],claimNext:async()=>{claims++;return null},recoverStale:async()=>({requeued:0,dead:0})};
  const worker=new BacktestWorker(config(),queue as any,undefined,authority as any);worker.start();await new Promise(r=>setTimeout(r,5));expect(worker.readiness()).toMatchObject({healthy:true,ready:false,reason:'owner-disabled'});expect(claims).toBe(0);
  decision={allowed:false,reason:'epoch-mismatch',authoritativeOwner:'service',authoritativeEpoch:3};await(worker as any).poll();expect(worker.ready).toBe(false);
  decision={allowed:false,reason:'authority-unavailable'};await(worker as any).poll();expect(worker.ready).toBe(false);
  decision={allowed:true,reason:'authorized',authoritativeOwner:'service',authoritativeEpoch:3};await(worker as any).poll();expect(worker.ready).toBe(true);expect(claims).toBe(1);await worker.stop();
})});
