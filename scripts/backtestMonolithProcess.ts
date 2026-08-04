import { processBacktestRun, getMonolithBacktestReadiness } from '@/lib/backtesting/runner/backtestQueue';
import { closeDbPool } from '@/lib/db';

async function main() {
  const runId = process.env.BACKTEST_HARNESS_RUN_ID;
  if (!runId) throw new Error('BACKTEST_HARNESS_RUN_ID is required');
  try {
    const readiness = await getMonolithBacktestReadiness();
    console.log(JSON.stringify({ event: 'harness_monolith_readiness', pid: process.pid, readiness }));
    if (!readiness.ready) { process.exitCode = 2; return; }
    const result = await processBacktestRun(runId);
    console.log(JSON.stringify({ event: 'harness_monolith_result', pid: process.pid, runId, result }));
  } finally { await closeDbPool(); }
}

void main().then(() => process.exit(process.exitCode ?? 0)).catch(error => { console.error(JSON.stringify({ event: 'harness_monolith_error', pid: process.pid, error: String(error) })); process.exit(1); });
