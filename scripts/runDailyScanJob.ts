/**
 * Manual trigger for scheduled daily scan jobs.
 *
 * Usage:
 *   npx tsx scripts/runDailyScanJob.ts readiness-check
 *   npx tsx scripts/runDailyScanJob.ts first-morning-scan
 *   npx tsx scripts/runDailyScanJob.ts main-morning-scan
 *   npx tsx scripts/runDailyScanJob.ts midday-rescore
 *   npx tsx scripts/runDailyScanJob.ts late-rescore
 *   npx tsx scripts/runDailyScanJob.ts evening-update
 *   npx tsx scripts/runDailyScanJob.ts evening-scan
 */

import { config as dotenvConfig } from 'dotenv';
import { resolveEnvFilePath } from '@/lib/envPath';
import { logRuntimeIdentity } from '@/lib/diagnostics/runtimeIdentity';

const envFile = resolveEnvFilePath();
dotenvConfig({ path: envFile });
process.env.Q365_PROCESS_ROLE = process.env.Q365_PROCESS_ROLE || 'scan-cli';
logRuntimeIdentity({
  component: 'runDailyScanJob',
  processRole: 'scan-cli',
  envFileHint: envFile,
});

import {
  runReadinessCheckJob,
  runFirstMorningScanJob,
  runMainMorningScanJob,
  runMiddayRescoreJob,
  runLateRescoreJob,
  runEveningUpdateJob,
  runEveningScanJob,
} from '@/lib/workers/dailyScanSchedule';

async function main(): Promise<void> {
  const job = (process.argv[2] ?? '').trim().toLowerCase();
  let result;
  switch (job) {
    case 'readiness-check':
    case 'readiness':
      result = await runReadinessCheckJob();
      break;
    case 'first-morning-scan':
    case 'morning-scan':
    case 'morning':
      result = await runFirstMorningScanJob();
      break;
    case 'main-morning-scan':
      result = await runMainMorningScanJob();
      break;
    case 'midday-rescore':
    case 'midday':
      result = await runMiddayRescoreJob();
      break;
    case 'late-rescore':
    case 'late':
      result = await runLateRescoreJob();
      break;
    case 'evening-update':
    case 'update':
      result = await runEveningUpdateJob();
      break;
    case 'evening-scan':
    case 'evening':
      result = await runEveningScanJob();
      break;
    default:
      console.error(
        'Usage: npx tsx scripts/runDailyScanJob.ts ' +
        '<readiness-check|first-morning-scan|main-morning-scan|midday-rescore|' +
        'late-rescore|evening-update|evening-scan>',
      );
      process.exit(1);
  }
  console.log('\n[DAILY_JOB RESULT]', JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('[runDailyScanJob] fatal:', err);
  process.exit(1);
});
