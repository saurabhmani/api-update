import { runBacktest } from '../runner/backtestRunner';
import { persistFullRun } from '../runner/runOrchestrator';
import type { LeaseClaim, MysqlBacktestLeaseQueue } from './leaseQueue';
export class BacktestCancelledError extends Error {}
export class BacktestLeaseLostError extends Error {}
export class BacktestOwnershipEpochLostError extends Error { constructor(readonly claimedEpoch:number,readonly authoritativeEpoch?:number){super(`Backtest processor ownership epoch ${claimedEpoch} is obsolete${authoritativeEpoch==null?'':`; authoritative epoch is ${authoritativeEpoch}`}`)} }
export async function processBacktestClaim(claim: LeaseClaim, queue: MysqlBacktestLeaseQueue, leaseDurationMs: number, signal: AbortSignal): Promise<'completed'|'cancelled'|'failed'|'queued'|'dead'|'lost'> {
  const checkpoint = async (percent?: number, step?: string) => {
    if (signal.aborted) throw new Error('Backtest worker shutting down');
    if (await queue.cancellationRequested(claim.runId, claim.processorId, claim.ownershipEpoch, claim.processorType)) throw new BacktestCancelledError('Backtest cancellation requested');
    if (!await queue.heartbeat(claim.runId, claim.processorId, leaseDurationMs, percent == null || step == null ? undefined : { percent, step }, claim.ownershipEpoch, claim.processorType)){const current=await queue.authoritativeOwnership();if(!current||current.epoch!==claim.ownershipEpoch||current.owner!==claim.processorType){console.warn(JSON.stringify({event:'backtest_stale_epoch_rejection',operation:'heartbeat',jobId:claim.runId,processorId:claim.processorId,processorType:claim.processorType,claimedEpoch:claim.ownershipEpoch,authoritativeEpoch:current?.epoch,authoritativeOwner:current?.owner,timestamp:new Date().toISOString()}));throw new BacktestOwnershipEpochLostError(claim.ownershipEpoch,current?.epoch)}throw new BacktestLeaseLostError('Backtest processor lease lost')}
  };
  try {
    await checkpoint(10, 'Loading market data');
    const result = await runBacktest({ ...claim.config, runId: claim.runId }, { onProgress: checkpoint });
    if (result.status === 'failed') return queue.fail(claim.runId, claim.processorId, 'engine_failure', result.error ?? 'Backtest failed', true, claim.ownershipEpoch, claim.processorType);
    await checkpoint(80, 'Persisting results');
    await persistFullRun(result, { preserveQueueStatus: true });
    await checkpoint(95, 'Finalizing');
    if(await queue.complete(claim.runId,claim.processorId,claim.ownershipEpoch,claim.processorType))return'completed';const current=await queue.authoritativeOwnership();if(!current||current.epoch!==claim.ownershipEpoch||current.owner!==claim.processorType)console.warn(JSON.stringify({event:'backtest_stale_epoch_rejection',operation:'completion',jobId:claim.runId,processorId:claim.processorId,processorType:claim.processorType,claimedEpoch:claim.ownershipEpoch,authoritativeEpoch:current?.epoch,authoritativeOwner:current?.owner,timestamp:new Date().toISOString()}));return'lost';
  } catch (error) {
    if (error instanceof BacktestCancelledError) return await queue.markCancelled(claim.runId, claim.processorId, claim.ownershipEpoch, claim.processorType) ? 'cancelled' : 'lost';
    if (error instanceof BacktestLeaseLostError) return 'lost';
    if (error instanceof BacktestOwnershipEpochLostError) return 'lost';
    return queue.fail(claim.runId, claim.processorId, signal.aborted ? 'worker_shutdown' : 'processor_error', error instanceof Error ? error.message : String(error), true, claim.ownershipEpoch, claim.processorType);
  }
}
