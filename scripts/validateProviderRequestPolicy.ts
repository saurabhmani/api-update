/**
 * validateProviderRequestPolicy.ts — acceptance checks for IndianAPI ops policy
 *
 * Usage:
 *   npm run validate:provider-request-policy
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import {
  DAILY_UPDATE_MAX_REQUESTS,
  EMERGENCY_REPAIR_MAX_FETCH,
  getProviderRequestPolicy,
  INITIAL_BACKFILL_EXPECTED_MAX,
  INITIAL_BACKFILL_EXPECTED_MIN,
  INITIAL_BACKFILL_PER_RUN_LIMIT,
  MONTHLY_PLANNING_MAX,
  MONTHLY_PLANNING_MIN,
  MONTHLY_PLANNING_TARGET,
} from '@/lib/marketData/providerRequestPolicy';
import {
  estimateBackfillApiRequests,
  runCandleBackfillJob,
} from '@/lib/marketData/candleBackfillJob';
import {
  estimateDailyUpdateApiRequests,
  runCandleDailyUpdateJob,
} from '@/lib/marketData/candleDailyUpdateJob';
import {
  INDIANAPI_MONTHLY_TARGET,
  getComplianceProjection,
} from '@/providers/adapters/indianApiUsageTracker';

interface CriterionResult {
  pass: boolean;
  detail: string;
}

async function main(): Promise<void> {
  const policy = getProviderRequestPolicy();
  const compliance = getComplianceProjection();

  const repairDry = await runCandleBackfillJob({
    dryRun: true,
    resume: true,
    maxFetch: EMERGENCY_REPAIR_MAX_FETCH(),
  });
  const dailyDry = await runCandleDailyUpdateJob({ dryRun: true });

  const repairEstimate = await estimateBackfillApiRequests({
    resume: true,
    maxFetch: EMERGENCY_REPAIR_MAX_FETCH(),
  });
  const dailyEstimate = await estimateDailyUpdateApiRequests();

  const criteria: Record<string, CriterionResult> = {
    '1_initial_backfill_band': {
      pass:
        INITIAL_BACKFILL_EXPECTED_MIN() >= 1000
        && INITIAL_BACKFILL_EXPECTED_MAX() <= 1500
        && INITIAL_BACKFILL_PER_RUN_LIMIT() <= INITIAL_BACKFILL_EXPECTED_MAX(),
      detail:
        `expected=${INITIAL_BACKFILL_EXPECTED_MIN()}–${INITIAL_BACKFILL_EXPECTED_MAX()} ` +
        `per_run=${INITIAL_BACKFILL_PER_RUN_LIMIT()}`,
    },
    '2_daily_scan_zero_api': {
      pass:
        policy.daily.morning_scan_max_requests === 0
        && policy.daily.evening_scan_max_requests === 0,
      detail:
        `morning=${policy.daily.morning_scan_max_requests} ` +
        `evening_scan=${policy.daily.evening_scan_max_requests}`,
    },
    '3_evening_update_cap': {
      pass:
        DAILY_UPDATE_MAX_REQUESTS() <= 1000
        && dailyEstimate <= DAILY_UPDATE_MAX_REQUESTS(),
      detail:
        `cap=${DAILY_UPDATE_MAX_REQUESTS()} estimate=${dailyEstimate} ` +
        `dry_run_fetched=${dailyDry.fetched}`,
    },
    '4_monthly_planning_band': {
      pass:
        MONTHLY_PLANNING_MIN() >= 22000
        && MONTHLY_PLANNING_MAX() <= 30000
        && MONTHLY_PLANNING_TARGET() >= MONTHLY_PLANNING_MIN()
        && MONTHLY_PLANNING_TARGET() <= MONTHLY_PLANNING_MAX()
        && INDIANAPI_MONTHLY_TARGET === MONTHLY_PLANNING_TARGET(),
      detail:
        `plan=${MONTHLY_PLANNING_MIN()}–${MONTHLY_PLANNING_MAX()} ` +
        `target=${MONTHLY_PLANNING_TARGET()} compliance=${compliance.label}`,
    },
    '5_emergency_repair_resume_only': {
      pass:
        policy.emergency_repair.resume_only
        && EMERGENCY_REPAIR_MAX_FETCH() <= 100
        && repairEstimate <= EMERGENCY_REPAIR_MAX_FETCH(),
      detail:
        `batch=${EMERGENCY_REPAIR_MAX_FETCH()} estimate=${repairEstimate} ` +
        `dry_run_fetched=${repairDry.fetched}`,
    },
    '6_avoid_list_documented': {
      pass: policy.avoid.length >= 5,
      detail: policy.avoid.join('; '),
    },
  };

  const passCount = Object.values(criteria).filter((c) => c.pass).length;
  const total = Object.keys(criteria).length;

  console.log('\n=== PROVIDER REQUEST POLICY VALIDATION ===\n');
  for (const [key, c] of Object.entries(criteria)) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${key}`);
    console.log(`       ${c.detail}\n`);
  }
  console.log(`Result: ${passCount}/${total} criteria passed\n`);
  console.log(JSON.stringify({ policy, criteria }, null, 2));

  process.exit(passCount === total ? 0 : 1);
}

main().catch((err) => {
  console.error('[validateProviderRequestPolicy] fatal:', err);
  process.exit(1);
});
