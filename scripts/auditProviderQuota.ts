/**
 * Audit IndianAPI provider request logs + quota headroom.
 *
 * Usage:
 *   npx tsx scripts/auditProviderQuota.ts
 *   npx tsx scripts/auditProviderQuota.ts --estimate-backfill
 *   npx tsx scripts/auditProviderQuota.ts --estimate-daily-update
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { migrateProviderRequestLogs } from '@/lib/db/migrateProviderRequestLogs';
import {
  aggregateProviderRequests,
  checkQuotaBeforeJob,
} from '@/lib/marketData/providerRequestLog';
import { estimateBackfillApiRequests } from '@/lib/marketData/candleBackfillJob';
import { estimateDailyUpdateApiRequests } from '@/lib/marketData/candleDailyUpdateJob';
import { getApiUsage } from '@/providers/adapters/IndianAPIAdapter';
import { getProviderRequestPolicy } from '@/lib/marketData/providerRequestPolicy';

async function main(): Promise<void> {
  await migrateProviderRequestLogs();
  const agg = await aggregateProviderRequests();
  const usage = getApiUsage();

  console.log('\n=== PROVIDER QUOTA AUDIT ===\n');
  console.log('Policy:', getProviderRequestPolicy());
  console.log('Counters (file):', {
    daily: `${usage.daily}/${usage.daily_limit}`,
    monthly: `${usage.monthly}/${usage.monthly_limit}`,
  });
  console.log('Logs (DB):', {
    today: agg.requests_today,
    month: agg.requests_this_month,
    monthly_remaining: agg.monthly_remaining,
    daily_remaining: agg.daily_remaining,
  });
  console.log('\nBy job (this month):');
  for (const row of agg.by_job) {
    console.log(`  ${row.source_job}: ${row.count}`);
  }
  console.log('\nBy endpoint (this month):');
  for (const row of agg.by_endpoint) {
    console.log(`  ${row.endpoint}: ${row.count}`);
  }

  if (process.argv.includes('--estimate-backfill')) {
    const estimate = await estimateBackfillApiRequests({ resume: true });
    const guard = await checkQuotaBeforeJob({
      estimatedRequests: estimate,
      jobId: 'audit-backfill',
      sourceJob: 'candle-backfill',
      warnOnly: true,
    });
    console.log('\nBackfill estimate:', { estimate, guard });
  }

  if (process.argv.includes('--estimate-daily-update')) {
    const estimate = await estimateDailyUpdateApiRequests();
    const guard = await checkQuotaBeforeJob({
      estimatedRequests: estimate,
      jobId: 'audit-daily-update',
      sourceJob: 'candle-daily-update',
      warnOnly: true,
    });
    console.log('\nDaily update estimate:', { estimate, guard });
  }
}

main().catch((err) => {
  console.error('[auditProviderQuota] fatal:', err);
  process.exit(1);
});
