/**
 * validateProviderQuotaGuard.ts — acceptance checks for IndianAPI quota guard
 *
 * Usage:
 *   npx tsx scripts/validateProviderQuotaGuard.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { db } from '@/lib/db';
import { migrateProviderRequestLogs } from '@/lib/db/migrateProviderRequestLogs';
import {
  aggregateProviderRequests,
  checkQuotaBeforeJob,
  logProviderRequest,
} from '@/lib/marketData/providerRequestLog';
import {
  estimateBackfillApiRequests,
  runCandleBackfillJob,
} from '@/lib/marketData/candleBackfillJob';
import {
  estimateDailyUpdateApiRequests,
  runCandleDailyUpdateJob,
} from '@/lib/marketData/candleDailyUpdateJob';
import {
  getApiUsage,
  INDIANAPI_MONTHLY_LIMIT,
  INDIANAPI_DAILY_LIMIT,
} from '@/providers/adapters/IndianAPIAdapter';
import { getComplianceProjection } from '@/providers/adapters/indianApiUsageTracker';

interface CriterionResult {
  pass: boolean;
  detail: string;
}

async function countDbLogs(): Promise<number> {
  const { rows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM provider_request_logs WHERE provider = 'indianapi'`,
  );
  return Number(rows[0]?.c ?? 0);
}

async function main(): Promise<void> {
  await migrateProviderRequestLogs();

  const beforeDb = await countDbLogs();
  const beforeUsage = getApiUsage();

  await logProviderRequest({
    endpoint: 'validate_test',
    symbol: 'TESTSYM',
    requestType: 'validation_probe',
    success: true,
    statusCode: 200,
    jobId: 'validate-quota-guard',
    sourceJob: 'validate-provider-quota',
    responseCount: 1,
  });
  const afterDb = await countDbLogs();
  const agg = await aggregateProviderRequests();

  const backfillDry = await runCandleBackfillJob({ dryRun: true, resume: true, maxFetch: 5 });
  const dailyDry = await runCandleDailyUpdateJob({ dryRun: true });

  const backfillEstimate = await estimateBackfillApiRequests({ resume: true });
  const dailyEstimate = await estimateDailyUpdateApiRequests();

  const normalGuard = await checkQuotaBeforeJob({
    estimatedRequests: 5,
    jobId: 'validate-small',
    sourceJob: 'validate-provider-quota',
    warnOnly: true,
  });

  const hugeGuard = await checkQuotaBeforeJob({
    estimatedRequests: INDIANAPI_MONTHLY_LIMIT + 1,
    jobId: 'validate-huge',
    sourceJob: 'validate-provider-quota',
    warnOnly: false,
  });

  const compliance = getComplianceProjection();
  const usage = getApiUsage();

  const criteria: Record<string, CriterionResult> = {
    '1_requests_counted': {
      pass:
        afterDb === beforeDb + 1
        && typeof usage.daily === 'number'
        && typeof usage.monthly === 'number'
        && agg.requests_this_month >= 1,
      detail:
        `DB logs ${beforeDb}→${afterDb} (probe insert); ` +
        `file counters daily=${usage.daily} monthly=${usage.monthly}; ` +
        `DB month count=${agg.requests_this_month}`,
    },
    '2_admin_can_see_usage': {
      pass:
        agg.requests_today >= 0
        && agg.monthly_remaining >= 0
        && Array.isArray(agg.by_job)
        && Array.isArray(agg.by_endpoint)
        && compliance.label != null
        && usage.daily_limit === INDIANAPI_DAILY_LIMIT
        && usage.monthly_limit === INDIANAPI_MONTHLY_LIMIT,
      detail:
        `aggregate: today=${agg.requests_today} month=${agg.requests_this_month} ` +
        `remaining=${agg.monthly_remaining}; compliance=${compliance.label}; ` +
        `limits daily=${usage.daily_limit} monthly=${usage.monthly_limit}; ` +
        `visibility via npm run quota:audit, GET /api/usage, GET /api/market-data/usage`,
    },
    '3_large_jobs_quota_guarded': {
      pass:
        hugeGuard.action === 'block'
        && hugeGuard.allowed === false
        && normalGuard.allowed === true
        && backfillEstimate < INDIANAPI_MONTHLY_LIMIT,
      detail:
        `small estimate=5 → action=${normalGuard.action} allowed=${normalGuard.allowed}; ` +
        `huge estimate=${INDIANAPI_MONTHLY_LIMIT + 1} → action=${hugeGuard.action} ` +
        `allowed=${hugeGuard.allowed}; resume backfill estimate=${backfillEstimate}`,
    },
    '4_backfill_reports_requests': {
      pass:
        typeof backfillDry.indianApiRequestsUsed === 'number'
        && backfillDry.indianApiRequestsUsed === 0
        && backfillDry.dryRun === true,
      detail:
        `dry-run summary indianApiRequestsUsed=${backfillDry.indianApiRequestsUsed} ` +
        `fetched=${backfillDry.fetched} skipped=${backfillDry.skippedSufficient} ` +
        `(0 API on dry-run; field present on live runs)`,
    },
    '5_daily_update_reports_requests': {
      pass:
        typeof dailyDry.requestsUsed === 'number'
        && dailyDry.requestsUsed === 0
        && dailyDry.dryRun === true,
      detail:
        `dry-run summary requestsUsed=${dailyDry.requestsUsed} ` +
        `would_fetch=${dailyDry.fetched} skipped=${dailyDry.skippedAlreadyUpdated} ` +
        `estimate=${dailyEstimate}`,
    },
  };

  const passCount = Object.values(criteria).filter((c) => c.pass).length;
  const total = Object.keys(criteria).length;

  console.log('\n=== PROVIDER QUOTA GUARD VALIDATION ===\n');
  for (const [key, c] of Object.entries(criteria)) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${key}`);
    console.log(`       ${c.detail}\n`);
  }
  console.log(`Result: ${passCount}/${total} criteria passed\n`);

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    criteria,
    backfill_dry_run: {
      indianApiRequestsUsed: backfillDry.indianApiRequestsUsed,
      fetched: backfillDry.fetched,
      skippedSufficient: backfillDry.skippedSufficient,
    },
    daily_dry_run: {
      requestsUsed: dailyDry.requestsUsed,
      fetched: dailyDry.fetched,
      skippedAlreadyUpdated: dailyDry.skippedAlreadyUpdated,
    },
    aggregation: agg,
    usage_before: { daily: beforeUsage.daily, monthly: beforeUsage.monthly },
    usage_after: { daily: usage.daily, monthly: usage.monthly },
  }, null, 2));

  process.exit(passCount === total ? 0 : 1);
}

main().catch((err) => {
  console.error('[validateProviderQuotaGuard] fatal:', err);
  process.exit(1);
});
