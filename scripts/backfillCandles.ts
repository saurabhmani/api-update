/**
 * scripts/backfillCandles.ts — IndianAPI daily candle backfill for NSE universe
 *
 * Quota-efficient workflow (limited IndianAPI requests):
 *   1. Plan (zero API calls):  npm run candles:backfill:plan
 *   2. Small live batch:       npm run candles:backfill:batch
 *   3. Repeat batch until plan shows fetched=0
 *
 * Usage:
 *   npx tsx scripts/backfillCandles.ts --resume --dry-run
 *   npx tsx scripts/backfillCandles.ts --resume --max-fetch 50
 *   npx tsx scripts/backfillCandles.ts --symbol RELIANCE --min-bars 240
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { runCandleBackfillJob } from '@/lib/marketData/candleBackfillJob';
import { getHistorical } from '@/lib/marketData/providers/indianApiProvider';
import { getIndianApiConfig } from '@/lib/marketData/providers/indianApiEndpoints';
import {
  EMERGENCY_REPAIR_MAX_FETCH,
  INITIAL_BACKFILL_PER_RUN_LIMIT,
  resolveBackfillMaxFetch,
  resolveBackfillPerRunLimit,
} from '@/lib/marketData/providerRequestPolicy';

interface CliArgs {
  limit: number;
  minBars: number;
  maxAgeDays: number;
  delayMs: number;
  dryRun: boolean;
  preflight: boolean;
  resume: boolean;
  maxFetch: number | undefined;
  symbols: string[];
}

function parseArgs(argv: string[]): CliArgs {
  let limit = Number(process.env.CANDLE_BACKFILL_UNIVERSE_LIMIT) || 1000;
  let minBars = Number(process.env.CANDLE_BACKFILL_MIN_BARS) || 240;
  let maxAgeDays = Number(process.env.CANDLE_BACKFILL_MAX_AGE_DAYS) || 7;
  let delayMs = Number(process.env.CANDLE_BACKFILL_REQUEST_DELAY_MS) || 800;
  let dryRun = false;
  let preflight = false;
  let resume = false;
  let maxFetch: number | undefined;
  const symbols: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--plan') dryRun = true;
    else if (a === '--preflight') preflight = true;
    else if (a === '--resume') resume = true;
    else if (a === '--limit' && argv[i + 1]) { limit = Number(argv[++i]); }
    else if (a === '--min-bars' && argv[i + 1]) { minBars = Number(argv[++i]); }
    else if (a === '--max-age-days' && argv[i + 1]) { maxAgeDays = Number(argv[++i]); }
    else if (a === '--delay-ms' && argv[i + 1]) { delayMs = Number(argv[++i]); }
    else if (a === '--max-fetch' && argv[i + 1]) { maxFetch = Number(argv[++i]); }
    else if (a === '--symbol' && argv[i + 1]) { symbols.push(String(argv[++i]).toUpperCase()); }
  }

  return {
    limit: Number.isFinite(limit) ? limit : 1000,
    minBars: Number.isFinite(minBars) ? minBars : 240,
    maxAgeDays: Number.isFinite(maxAgeDays) ? maxAgeDays : 7,
    delayMs: Number.isFinite(delayMs) ? delayMs : 800,
    dryRun,
    preflight,
    resume: resume || symbols.length === 0,
    maxFetch: maxFetch != null && Number.isFinite(maxFetch) ? maxFetch : undefined,
    symbols,
  };
}

async function runPreflight(symbol = 'RELIANCE'): Promise<boolean> {
  const { apiKey, baseUrl } = getIndianApiConfig();
  if (!apiKey) {
    console.error('[CANDLE BACKFILL PREFLIGHT] INDIANAPI_API_KEY is not set');
    return false;
  }
  console.log(`[CANDLE BACKFILL PREFLIGHT] probing ${symbol} via ${baseUrl} ...`);
  const inv = await getHistorical(symbol, '1y');
  const bars = inv.data?.candles?.length ?? 0;
  if (inv.status === 'success' || inv.status === 'partial') {
    console.log(`[CANDLE BACKFILL PREFLIGHT] OK — ${bars} bars returned`);
    return true;
  }
  console.error(
    `[CANDLE BACKFILL PREFLIGHT] FAIL — ${inv.errorCode ?? 'unknown'}: ` +
    `${inv.errorMessage ?? inv.status}`,
  );
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.preflight) {
    const sym = args.symbols[0] ?? 'RELIANCE';
    const ok = await runPreflight(sym);
    process.exit(ok ? 0 : 1);
  }

  if (args.dryRun) {
    console.log(
      '[CANDLE BACKFILL PLAN] dry-run — no IndianAPI calls, no DB writes. ' +
      '`fetched` = API requests that a live run would make.',
    );
  }

  const effectiveFetchCap = args.maxFetch ?? resolveBackfillMaxFetch({
    resume: args.resume,
    symbols: args.symbols,
  });
  const effectivePerRun = resolveBackfillPerRunLimit({
    resume: args.resume,
    maxFetch: args.maxFetch,
    symbols: args.symbols,
  });
  if (
    !args.dryRun
    && !args.symbols.length
    && args.resume
    && effectiveFetchCap < args.limit
  ) {
    console.warn(
      `[CANDLE BACKFILL] Quota guard: will fetch at most ${effectiveFetchCap} symbols this run ` +
      `(policy repair batch=${EMERGENCY_REPAIR_MAX_FETCH()}, per_run=${effectivePerRun}). ` +
      `Run npm run candles:backfill:preflight first. Re-run --resume until plan shows fetched=0.`,
    );
  }

  const summary = await runCandleBackfillJob({
    universeLimit: args.limit,
    minBars: args.minBars,
    maxAgeDays: args.maxAgeDays,
    requestDelayMs: args.delayMs,
    dryRun: args.dryRun,
    resume: args.symbols.length === 0 && args.resume,
    maxFetch: args.maxFetch,
    symbols: args.symbols.length > 0 ? args.symbols : undefined,
  });

  console.log('\n[CANDLE BACKFILL SUMMARY]');
  console.log(JSON.stringify({
    universe_total: summary.universeTotal,
    already_sufficient: summary.alreadySufficient,
    symbols_attempted: summary.universeTotal,
    queue_this_run: summary.totalSymbols,
    skipped_already_sufficient: summary.skippedSufficient,
    fetched: summary.fetched,
    failed: summary.failed,
    deferred_remaining: summary.deferredDueToBudget,
    candles_inserted: summary.candlesInserted,
    candles_updated: summary.candlesUpdated,
    indianapi_requests_used: summary.indianApiRequestsUsed,
    duration_ms: summary.durationMs,
    dry_run: summary.dryRun,
  }, null, 2));

  if (args.dryRun && summary.fetched > 0) {
    console.log(
      `\nEstimated live API cost: ${summary.fetched} requests. ` +
      `Repair batches: npm run candles:repair. ` +
      `Initial one-shot: npx tsx scripts/backfillCandles.ts --max-fetch ${INITIAL_BACKFILL_PER_RUN_LIMIT()}`,
    );
  }

  if (summary.failures.length > 0) {
    console.log('\nFailures (first 20):');
    for (const f of summary.failures.slice(0, 20)) {
      console.log(`  ${f.symbol}: ${f.reason}`);
    }
  }

  process.exit(summary.failed > 0 && summary.fetched === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[CANDLE BACKFILL] fatal:', err);
  process.exit(1);
});
