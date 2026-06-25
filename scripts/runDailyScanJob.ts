/**
 * Manual trigger for scheduled daily scan jobs.
 *
 * Usage:
 *   npx tsx scripts/runDailyScanJob.ts morning-scan
 *   npx tsx scripts/runDailyScanJob.ts evening-update
 *   npx tsx scripts/runDailyScanJob.ts evening-scan
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import {
  runMorningScanJob,
  runEveningUpdateJob,
  runEveningScanJob,
} from '@/lib/workers/dailyScanSchedule';

async function main(): Promise<void> {
  const job = (process.argv[2] ?? '').trim().toLowerCase();
  let result;
  switch (job) {
    case 'morning-scan':
    case 'morning':
      result = await runMorningScanJob();
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
        'Usage: npx tsx scripts/runDailyScanJob.ts <morning-scan|evening-update|evening-scan>',
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
