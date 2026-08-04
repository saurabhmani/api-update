import { backtestLeaseQueue } from '@/lib/backtesting/queue/leaseQueue';
import { getBacktestProcessorOwner } from '@/lib/backtesting/queue/ownership';

async function main() {
  const executeRecovery = process.argv.includes('--execute-recovery');
  const owner = getBacktestProcessorOwner(); const before = await backtestLeaseQueue.operationalSnapshot();
  const audit: Record<string, unknown> = { timestamp:new Date().toISOString(), dryRun:!executeRecovery, owner, before };
  if (owner !== 'disabled') {
    audit.safe = false; audit.instructions = ['Set BACKTEST_PROCESSOR_OWNER=disabled for monolith and worker', 'Restart both processes and verify worker readiness is false', 'Re-run this command'];
    console.log(JSON.stringify(audit)); process.exitCode=2; return;
  }
  audit.safe = true;
  if (executeRecovery) audit.recovery = await backtestLeaseQueue.recoverStale();
  audit.after = await backtestLeaseQueue.operationalSnapshot();
  audit.instructions = ['Verify no active service-owned jobs remain', 'Stop the staging worker', 'Set BACKTEST_PROCESSOR_OWNER=monolith on the monolith', 'Restart monolith and run staging preflight'];
  console.log(JSON.stringify(audit));
}
void main().catch(error => { console.error(JSON.stringify({ safe:false,error:String(error) })); process.exitCode=1; });
