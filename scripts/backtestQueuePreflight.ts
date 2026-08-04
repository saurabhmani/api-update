import { db } from '@/lib/db';
import type { QueueDb } from '@/lib/backtesting/queue/leaseQueue';
async function count(database: QueueDb, sql: string): Promise<number> { const { rows } = await database.query<{ n: number }>(sql); return Number(rows[0]?.n ?? 0); }
export async function runBacktestQueuePreflight(database: QueueDb = db, databaseName = process.env.MYSQL_DATABASE ?? process.env.DB_NAME ?? 'unknown') {
  const report = {
    duplicateIdempotencyValues: await count(database, `SELECT COUNT(*) n FROM (SELECT idempotency_key FROM backtest_runs WHERE idempotency_key IS NOT NULL GROUP BY idempotency_key HAVING COUNT(*)>1) x`),
    invalidStatuses: await count(database, `SELECT COUNT(*) n FROM backtest_runs WHERE status NOT IN ('queued','running','cancel_requested','cancelled','completed','failed','dead','success','partial_success')`),
    runningWithoutTimestamps: await count(database, `SELECT COUNT(*) n FROM backtest_runs WHERE status='running' AND (claimed_at IS NULL OR lease_expires_at IS NULL)`),
    terminalWithoutCompletion: await count(database, `SELECT COUNT(*) n FROM backtest_runs WHERE status IN ('completed','cancelled','failed','dead') AND completed_at IS NULL`),
    staleRunningJobs: await count(database, `SELECT COUNT(*) n FROM backtest_runs WHERE status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=NOW()`),
    attemptsExhausted: await count(database, `SELECT COUNT(*) n FROM backtest_runs WHERE attempt_count>=max_attempts AND status IN ('queued','running')`),
    cancellationInconsistencies: await count(database, `SELECT COUNT(*) n FROM backtest_runs WHERE cancellation_requested_at IS NOT NULL AND status NOT IN ('cancel_requested','cancelled','failed','dead')`),
    ownerlessBacktests: await count(database, `SELECT COUNT(*) n FROM backtest_runs WHERE created_by IS NULL`),
  };
  const metadata = { database: databaseName, migration: '016', executedAt: new Date().toISOString() };
  const blockers = ['invalidStatuses', 'runningWithoutTimestamps', 'attemptsExhausted', 'cancellationInconsistencies'] as const;
  const warnings = ['duplicateIdempotencyValues', 'terminalWithoutCompletion', 'staleRunningJobs', 'ownerlessBacktests'] as const;
  const ok = blockers.every(key => report[key] === 0);
  const output = { ok, metadata, blockers: Object.fromEntries(blockers.map(key => [key, report[key]])), warnings: Object.fromEntries(warnings.map(key => [key, report[key]])), report };
  return output;
}
if (process.argv[1]?.replaceAll('\\','/').endsWith('/scripts/backtestQueuePreflight.ts')) runBacktestQueuePreflight().then(output => {
  console.log(JSON.stringify(output));
  console.error(`Backtest preflight ${output.ok ? 'PASS' : 'BLOCKED'}`);
  if (!output.ok) process.exitCode = 2;
}).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
