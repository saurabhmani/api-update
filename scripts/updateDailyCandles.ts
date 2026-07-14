/**
 * scripts/updateDailyCandles.ts — post-close incremental daily candle update
 *
 * Quota-efficient: skips symbols already on the latest completed trading day;
 * uses Kite 1mo for incremental, 1y only when bar depth is insufficient.
 *
 * Usage:
 *   npm run candles:daily
 *   npm run candles:daily:plan
 *   npx tsx scripts/updateDailyCandles.ts --max-fetch 100
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });
dotenvConfig({ path: resolvePath(process.cwd(), '.env') });

import { runCandleDailyUpdateJob } from '@/lib/marketData/candleDailyUpdateJob';
import { getHistorical as getKiteHistorical, isKiteHistoricalConfigured } from '@/lib/marketData/providers/kiteHistoricalProvider';
import { getLatestCompletedTradingDay } from '@/lib/marketData/marketHours';
import { DAILY_UPDATE_MAX_REQUESTS } from '@/lib/marketData/providerRequestPolicy';

interface CliArgs {
  limit: number;
  minBars: number;
  delayMs: number;
  dryRun: boolean;
  preflight: boolean;
  maxFetch: number | undefined;
  symbols: string[];
}

function parseArgs(argv: string[]): CliArgs {
  let limit = Number(process.env.CANDLE_BACKFILL_UNIVERSE_LIMIT) || 1000;
  let minBars = Number(process.env.CANDLE_BACKFILL_MIN_BARS) || 240;
  let delayMs = Number(process.env.CANDLE_DAILY_UPDATE_DELAY_MS)
    || Number(process.env.CANDLE_BACKFILL_REQUEST_DELAY_MS)
    || 800;
  let dryRun = false;
  let preflight = false;
  let maxFetch: number | undefined;
  const symbols: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run' || a === '--plan') dryRun = true;
    else if (a === '--preflight') preflight = true;
    else if (a === '--limit' && argv[i + 1]) limit = Number(argv[++i]);
    else if (a === '--min-bars' && argv[i + 1]) minBars = Number(argv[++i]);
    else if (a === '--delay-ms' && argv[i + 1]) delayMs = Number(argv[++i]);
    else if (a === '--max-fetch' && argv[i + 1]) maxFetch = Number(argv[++i]);
    else if (a === '--symbol' && argv[i + 1]) symbols.push(String(argv[++i]).toUpperCase());
  }

  return {
    limit: Number.isFinite(limit) ? limit : 1000,
    minBars: Number.isFinite(minBars) ? minBars : 240,
    delayMs: Number.isFinite(delayMs) ? delayMs : 800,
    dryRun,
    preflight,
    maxFetch: maxFetch != null && Number.isFinite(maxFetch) ? maxFetch : undefined,
    symbols,
  };
}

async function runPreflight(symbol = 'RELIANCE'): Promise<boolean> {
  if (!isKiteHistoricalConfigured()) {
    console.error('[CANDLE DAILY PREFLIGHT] Kite historical is not configured');
    return false;
  }
  console.log(`[CANDLE DAILY PREFLIGHT] probing ${symbol} via Kite ...`);
  const kite = await getKiteHistorical(symbol, '1mo');
  const bars = kite.data?.candles?.length ?? 0;
  if (kite.status === 'success' || kite.status === 'partial') {
    console.log(`[CANDLE DAILY PREFLIGHT] OK (kite) — ${bars} bars (1mo)`);
    return true;
  }
  console.error(`[CANDLE DAILY PREFLIGHT] FAIL — ${kite.errorCode}: ${kite.errorMessage}`);
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.preflight) {
    const ok = await runPreflight(args.symbols[0] ?? 'RELIANCE');
    process.exit(ok ? 0 : 1);
  }

  const targetDay = getLatestCompletedTradingDay();
  if (args.dryRun) {
    console.log(
      `[CANDLE DAILY PLAN] dry-run — target_trading_day=${targetDay} ` +
      '(no API calls / no DB writes; `fetched` = would-call count)',
    );
  }

  const summary = await runCandleDailyUpdateJob({
    universeLimit: args.limit,
    minBars: args.minBars,
    requestDelayMs: args.delayMs,
    dryRun: args.dryRun,
    maxFetch: args.maxFetch,
    symbols: args.symbols.length > 0 ? args.symbols : undefined,
  });

  const policyCap = DAILY_UPDATE_MAX_REQUESTS();
  if (!args.dryRun && summary.requestsUsed > policyCap) {
    console.warn(
      `[CANDLE DAILY UPDATE] requests_used=${summary.requestsUsed} exceeded policy cap=${policyCap}`,
    );
  }

  console.log('\n[CANDLE DAILY UPDATE SUMMARY]');
  console.log(JSON.stringify({
    total_symbols: summary.totalSymbols,
    skipped_already_updated: summary.skippedAlreadyUpdated,
    fetched: summary.fetched,
    failed: summary.failed,
    requests_used: summary.requestsUsed,
    latest_candle_date: summary.latestCandleDate,
    target_trading_day: summary.targetTradingDay,
    candles_inserted: summary.candlesInserted,
    candles_updated: summary.candlesUpdated,
    deferred_remaining: summary.deferredRemaining,
    duration_ms: summary.durationMs,
    dry_run: summary.dryRun,
  }, null, 2));

  if (args.dryRun && summary.fetched > 0) {
    console.log(
      `\nEstimated live API cost: ${summary.fetched} requests ` +
      `(thin symbols use 1y; others use 1mo incremental).`,
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
  console.error('[CANDLE DAILY UPDATE] fatal:', err);
  process.exit(1);
});
