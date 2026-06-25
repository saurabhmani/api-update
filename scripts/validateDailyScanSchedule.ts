/**
 * validateDailyScanSchedule.ts — acceptance checks for daily scan cadence
 *
 * Usage:
 *   npx tsx scripts/validateDailyScanSchedule.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { db } from '@/lib/db';
import { loadActiveUniverseSymbols } from '@/lib/marketData/candleBackfillJob';
import {
  fetchDailyCandlesWithFallback,
  getIndianApiCandleRequestCount,
  readDailyCandlesFromDb,
  resetCandleSourceCounters,
} from '@/lib/marketData/candleFallbackChain';
import { runCandleDailyUpdateJob } from '@/lib/marketData/candleDailyUpdateJob';
import { getLatestCompletedTradingDay, toIstCalendarDate } from '@/lib/marketData/marketHours';
import { getApiUsage, INDIANAPI_MONTHLY_LIMIT } from '@/providers/adapters/IndianAPIAdapter';

const TRADING_DAYS_PER_MONTH = 22;
const MORNING_SCAN_API_CEILING = 0;
const EVENING_UPDATE_DAILY_CEILING = 1000;

interface CriterionResult {
  pass: boolean;
  detail: string;
}

async function probeMorningScanApiUsage(universe: string[]): Promise<{
  symbolsProbed: number;
  indianapiRequests: number;
}> {
  resetCandleSourceCounters();
  const sample = universe.slice(0, Math.min(universe.length, 100));
  for (const sym of sample) {
    await fetchDailyCandlesWithFallback(sym, { dbOnly: true, evaluationRead: true });
  }
  return {
    symbolsProbed: sample.length,
    indianapiRequests: getIndianApiCandleRequestCount(),
  };
}

async function probeEveningScanDbReads(universe: string[]): Promise<{
  symbolsProbed: number;
  indianapiRequests: number;
  globalLatest: string | null;
  targetDay: string;
  symbolsAtTarget: number;
  sampleLatest: string | null;
}> {
  const targetDay = getLatestCompletedTradingDay();
  resetCandleSourceCounters();
  const sample = universe.slice(0, 20);
  let sampleLatest: string | null = null;
  for (const sym of sample) {
    const candles = await readDailyCandlesFromDb(sym);
    const result = await fetchDailyCandlesWithFallback(sym, { dbOnly: true, evaluationRead: true });
    if (!sampleLatest && candles.length > 0) {
      const ts = candles[candles.length - 1]?.ts;
      sampleLatest = ts ? toIstCalendarDate(new Date(ts)) : null;
    }
    void result;
  }

  const { rows } = await db.query<{ c: number }>(
    `SELECT COUNT(*) AS c
       FROM q365_universe u
       LEFT JOIN (
         SELECT symbol, MAX(ts) AS latest_ts
           FROM market_data_daily
          GROUP BY symbol
       ) d ON d.symbol COLLATE utf8mb4_unicode_ci = u.symbol COLLATE utf8mb4_unicode_ci
      WHERE u.is_active = 1
        AND d.latest_ts IS NOT NULL
        AND DATE(d.latest_ts) >= ?`,
    [targetDay],
  );

  const { rows: maxRows } = await db.query<{ latest: Date | string | null }>(
    `SELECT MAX(ts) AS latest FROM market_data_daily`,
  );
  const raw = maxRows[0]?.latest;
  const globalLatest = raw
    ? toIstCalendarDate(raw instanceof Date ? raw : new Date(raw))
    : null;

  return {
    symbolsProbed: sample.length,
    indianapiRequests: getIndianApiCandleRequestCount(),
    globalLatest,
    targetDay,
    symbolsAtTarget: Number(rows[0]?.c ?? 0),
    sampleLatest,
  };
}

async function main(): Promise<void> {
  const universe = await loadActiveUniverseSymbols(1000);
  const usage = getApiUsage();

  const morning = await probeMorningScanApiUsage(universe);
  const eveningPlan = await runCandleDailyUpdateJob({ dryRun: true });
  const eveningDb = await probeEveningScanDbReads(universe);

  const incrementalWouldFetch = eveningPlan.fetched;
  const incrementalWouldSkip = eveningPlan.skippedAlreadyUpdated;
  const worstCaseDaily =
    incrementalWouldFetch +
    eveningPlan.deferredRemaining;
  const projectedMonthlyEvening = worstCaseDaily * TRADING_DAYS_PER_MONTH;
  const projectedMonthlyTotal = usage.monthly + projectedMonthlyEvening;
  const monthlyHeadroom = INDIANAPI_MONTHLY_LIMIT - usage.monthly;
  const withinMonthly =
    !usage.monthly_exceeded
    && projectedMonthlyTotal <= INDIANAPI_MONTHLY_LIMIT;

  const criteria: Record<string, CriterionResult> = {
    '1_morning_scan_no_historical_api': {
      pass: morning.indianapiRequests <= MORNING_SCAN_API_CEILING,
      detail:
        `Morning path (dbOnly) probed ${morning.symbolsProbed} symbols → ` +
        `indianapi_requests=${morning.indianapiRequests} (ceiling ${MORNING_SCAN_API_CEILING}; ` +
        `full universe=${universe.length} would also be 0)`,
    },
    '2_evening_update_incremental_only': {
      pass:
        incrementalWouldFetch < universe.length
        && incrementalWouldFetch <= EVENING_UPDATE_DAILY_CEILING,
      detail:
        `Dry-run: total=${eveningPlan.totalSymbols} skip=${incrementalWouldSkip} ` +
        `would_fetch=${incrementalWouldFetch} failed=${eveningPlan.failed} ` +
        `(not full-history for all ${universe.length}; 1 call/symbol max when behind target)`,
    },
    '3_evening_scan_reads_updated_db': {
      pass:
        eveningDb.indianapiRequests === 0
        && eveningDb.symbolsAtTarget > 0
        && (eveningDb.globalLatest ?? '') >= eveningDb.targetDay,
      detail:
        `Evening scan path dbOnly: api=${eveningDb.indianapiRequests} ` +
        `global_latest=${eveningDb.globalLatest} target=${eveningDb.targetDay} ` +
        `symbols_at_target=${eveningDb.symbolsAtTarget}/${universe.length} ` +
        `sample_latest=${eveningDb.sampleLatest}`,
    },
    '4_monthly_scope': {
      pass: withinMonthly,
      detail:
        `monthly=${usage.monthly}/${usage.monthly_limit} ` +
        `remaining=${usage.monthly_remaining} ` +
        `projected_evening_only=${projectedMonthlyEvening}/mo ` +
        `(${worstCaseDaily}/day × ${TRADING_DAYS_PER_MONTH} days) ` +
        `projected_total=${projectedMonthlyTotal} ` +
        `exceeded=${usage.monthly_exceeded}`,
    },
  };

  const passCount = Object.values(criteria).filter((c) => c.pass).length;
  const total = Object.keys(criteria).length;

  console.log('\n=== DAILY SCAN SCHEDULE VALIDATION ===\n');
  for (const [key, c] of Object.entries(criteria)) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${key}`);
    console.log(`       ${c.detail}\n`);
  }
  console.log(`Result: ${passCount}/${total} criteria passed\n`);

  const report = {
    timestamp: new Date().toISOString(),
    universe_size: universe.length,
    morning_probe: morning,
    evening_update_dry_run: {
      totalSymbols: eveningPlan.totalSymbols,
      skippedAlreadyUpdated: eveningPlan.skippedAlreadyUpdated,
      wouldFetch: eveningPlan.fetched,
      failed: eveningPlan.failed,
      targetTradingDay: eveningPlan.targetTradingDay,
      latestCandleDate: eveningPlan.latestCandleDate,
    },
    evening_scan_db_probe: eveningDb,
    api_usage: usage,
    monthly_projection: {
      trading_days_per_month: TRADING_DAYS_PER_MONTH,
      worst_case_daily_evening_calls: worstCaseDaily,
      projected_monthly_evening_calls: projectedMonthlyEvening,
      projected_monthly_total: projectedMonthlyTotal,
      monthly_limit: INDIANAPI_MONTHLY_LIMIT,
      within_monthly_scope: withinMonthly,
    },
    criteria,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(passCount === total ? 0 : 1);
}

main().catch((err) => {
  console.error('[validateDailyScanSchedule] fatal:', err);
  process.exit(1);
});
