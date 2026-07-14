// ════════════════════════════════════════════════════════════════
//  Candle Daily Update Job — post-close incremental EOD refresh
//
//  Fetches only missing latest daily bars for active NSE symbols.
//  Uses Kite `1mo` for incremental; `1y` when thin.
//  Writes ONLY to `candles` (market_data_daily is a view).
//
//  Usage:
//    import { runCandleDailyUpdateJob } from '@/lib/marketData/candleDailyUpdateJob';
//    const summary = await runCandleDailyUpdateJob();
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import {
  fetchUpstreamDailyCandles,
  getKiteCandleRequestCount,
  resetCandleSourceCounters,
} from '@/lib/marketData/candleFallbackChain';
import {
  getLatestCompletedTradingDay,
  toIstCalendarDate,
} from '@/lib/marketData/marketHours';
import {
  BACKFILL_MIN_BARS_DEFAULT,
  BACKFILL_REQUEST_DELAY_MS_DEFAULT,
  BACKFILL_UNIVERSE_LIMIT_DEFAULT,
  getSymbolCandleStats,
  loadActiveUniverseSymbols,
  persistBarsForSymbol,
} from '@/lib/marketData/candleBackfillJob';
import { isKiteHistoricalConfigured } from '@/lib/marketData/providers/kiteHistoricalProvider';
import type { HistoricalRange } from '@/types/market';
import { assertQuotaForJob } from '@/lib/marketData/providerRequestLog';
import { runWithProviderRequestContext } from '@/lib/marketData/providerRequestContext';
import {
  DAILY_UPDATE_MAX_REQUESTS,
  resolveDailyUpdateMaxFetch,
} from '@/lib/marketData/providerRequestPolicy';

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

const RATE_LIMIT_BACKOFF_MS = () =>
  envNum('CANDLE_BACKFILL_RATE_LIMIT_BACKOFF_MS', 1_000, 120_000, 15_000);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface CandleDailyUpdateJobOptions {
  universeLimit?: number;
  /** Below this bar count, fetch full 1y history instead of 1mo. */
  minBars?: number;
  requestDelayMs?: number;
  dryRun?: boolean;
  symbols?: string[];
  maxFetch?: number;
}

export interface CandleDailyUpdateFailure {
  symbol: string;
  reason: string;
}

export interface CandleDailyUpdateSummary {
  totalSymbols: number;
  skippedAlreadyUpdated: number;
  fetched: number;
  failed: number;
  requestsUsed: number;
  latestCandleDate: string | null;
  targetTradingDay: string;
  candlesInserted: number;
  candlesUpdated: number;
  deferredRemaining: number;
  failures: CandleDailyUpdateFailure[];
  durationMs: number;
  dryRun: boolean;
}

function isPerRunBudgetExhausted(): boolean {
  return false;
}

function perRunBudgetFailureReason(): string {
  return "PER_RUN_LIMIT_EXCEEDED";
}

function isAbortReason(reason: string | undefined): 'budget' | 'auth' | null {
  if (!reason) return null;
  if (
    reason.includes('PER_RUN_LIMIT_EXCEEDED')
    || reason.includes('API_BUDGET_EXCEEDED')
    || reason.includes('per-run budget exhausted')
  ) return 'budget';
  if (
    reason.includes('AUTH_FAILED')
    || reason.includes('API_KEY_INVALID')
    || reason.includes('status code 403')
  ) return 'auth';
  return null;
}

function filterBarsForIncremental(
  bars: Array<{ ts: string | Date; open: number; high: number; low: number; close: number; volume: number }>,
  latestDate: string | null,
): typeof bars {
  if (!latestDate) return bars;
  return bars.filter((bar) => {
    const ts = bar.ts instanceof Date ? bar.ts : new Date(bar.ts);
    if (Number.isNaN(ts.getTime())) return false;
    return toIstCalendarDate(ts) > latestDate;
  });
}

async function queryGlobalLatestCandleDate(): Promise<string | null> {
  const { rows } = await db.query<{ latest: Date | string | null }>(
    `SELECT MAX(ts) AS latest FROM market_data_daily`,
  );
  const raw = rows[0]?.latest;
  if (!raw) return null;
  const ts = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(ts.getTime())) return null;
  return toIstCalendarDate(ts);
}

async function updateOneSymbol(
  symbol: string,
  opts: {
    targetTradingDay: string;
    minBars: number;
    dryRun: boolean;
  },
): Promise<{
  status: 'skipped' | 'fetched' | 'failed';
  inserted: number;
  updated: number;
  reason?: string;
}> {
  const stats = await getSymbolCandleStats(symbol);
  const latestDate = stats.latestTs ? toIstCalendarDate(stats.latestTs) : null;

  if (latestDate != null && latestDate >= opts.targetTradingDay) {
    return {
      status: 'skipped',
      inserted: 0,
      updated: 0,
      reason: `already_current: latest=${latestDate} target=${opts.targetTradingDay}`,
    };
  }

  if (opts.dryRun) {
    const mode = stats.barCount < opts.minBars ? '1y_backfill' : '1mo_incremental';
    return {
      status: 'fetched',
      inserted: 0,
      updated: 0,
      reason: `dry_run: would_${mode} bars=${stats.barCount}`,
    };
  }

  if (isPerRunBudgetExhausted()) {
    return {
      status: 'failed',
      inserted: 0,
      updated: 0,
      reason: perRunBudgetFailureReason(),
    };
  }

  const thin = stats.barCount < opts.minBars;
  const range: HistoricalRange = thin ? '1y' : '1mo';

  let fetch = await fetchUpstreamDailyCandles(symbol, range);
  if (
    !fetch.ok
    && (fetch.errorCode === 'RATE_LIMITED' || fetch.errorCode === 'KiteRateLimitError')
  ) {
    await sleep(RATE_LIMIT_BACKOFF_MS());
    fetch = await fetchUpstreamDailyCandles(symbol, range);
  }

  if (!fetch.ok || fetch.candles.length === 0) {
    return {
      status: 'failed',
      inserted: 0,
      updated: 0,
      reason: fetch.errorMessage ?? String(fetch.errorCode ?? 'fetch_failed'),
    };
  }

  const bars = thin
    ? fetch.candles
    : filterBarsForIncremental(fetch.candles, latestDate);

  if (bars.length === 0) {
    return {
      status: 'skipped',
      inserted: 0,
      updated: 0,
      reason: `no_new_bars_after_filter latest=${latestDate ?? 'none'}`,
    };
  }

  const { inserted, updated } = await persistBarsForSymbol(symbol, bars);
  if (inserted === 0 && updated === 0) {
    return {
      status: 'failed',
      inserted: 0,
      updated: 0,
      reason: 'no_valid_bars_after_upsert',
    };
  }

  return { status: 'fetched', inserted, updated };
}

export async function estimateDailyUpdateApiRequests(
  options: Pick<CandleDailyUpdateJobOptions, 'universeLimit' | 'minBars' | 'symbols'> = {},
): Promise<number> {
  const universeLimit = options.universeLimit ?? BACKFILL_UNIVERSE_LIMIT_DEFAULT();
  const minBars = options.minBars ?? BACKFILL_MIN_BARS_DEFAULT();
  const targetTradingDay = getLatestCompletedTradingDay();
  const symbols = options.symbols?.length
    ? options.symbols.map((s) => s.toUpperCase()).slice(0, universeLimit)
    : await loadActiveUniverseSymbols(universeLimit);

  let wouldFetch = 0;
  for (const symbol of symbols) {
    const stats = await getSymbolCandleStats(symbol);
    const latestDate = stats.latestTs ? toIstCalendarDate(stats.latestTs) : null;
    if (latestDate != null && latestDate >= targetTradingDay) continue;
    wouldFetch++;
  }
  return wouldFetch;
}

export async function runCandleDailyUpdateJob(
  options: CandleDailyUpdateJobOptions = {},
): Promise<CandleDailyUpdateSummary> {
  const jobId = `candle-daily-update_${Date.now()}`;
  const dryRun = options.dryRun ?? false;
  if (!dryRun) {
    const estimate = await estimateDailyUpdateApiRequests(options);
    await assertQuotaForJob({
      estimatedRequests: estimate,
      jobId,
      sourceJob: 'candle-daily-update',
    });
  }
  return runWithProviderRequestContext(
    { jobId, sourceJob: 'candle-daily-update', requestType: 'incremental_daily' },
    () => runCandleDailyUpdateJobInner(options),
  );
}

async function runCandleDailyUpdateJobInner(
  options: CandleDailyUpdateJobOptions = {},
): Promise<CandleDailyUpdateSummary> {
  const t0 = Date.now();
  const universeLimit = options.universeLimit ?? BACKFILL_UNIVERSE_LIMIT_DEFAULT();
  const minBars = options.minBars ?? BACKFILL_MIN_BARS_DEFAULT();
  const requestDelayMs = options.requestDelayMs ?? BACKFILL_REQUEST_DELAY_MS_DEFAULT();
  const dryRun = options.dryRun ?? false;
  const maxFetch = resolveDailyUpdateMaxFetch(options.maxFetch);
  const targetTradingDay = getLatestCompletedTradingDay();

  if (!isKiteHistoricalConfigured() && !dryRun) {
    throw new Error(
      'No historical upstream configured — set KITE_API_KEY+KITE_ACCESS_TOKEN '
      + 'before running daily update',
    );
  }

  resetCandleSourceCounters();

  const symbols = options.symbols?.length
    ? options.symbols.map((s) => s.toUpperCase()).slice(0, universeLimit)
    : await loadActiveUniverseSymbols(universeLimit);

  const summary: CandleDailyUpdateSummary = {
    totalSymbols: symbols.length,
    skippedAlreadyUpdated: 0,
    fetched: 0,
    failed: 0,
    requestsUsed: 0,
    latestCandleDate: await queryGlobalLatestCandleDate(),
    targetTradingDay,
    candlesInserted: 0,
    candlesUpdated: 0,
    deferredRemaining: 0,
    failures: [],
    durationMs: 0,
    dryRun,
  };

  console.log(
    `[CANDLE DAILY UPDATE] start symbols=${symbols.length} target_day=${targetTradingDay} ` +
    `min_bars=${minBars} delay_ms=${requestDelayMs} dry_run=${dryRun} ` +
    `max_fetch=${maxFetch} per_run_limit=${DAILY_UPDATE_MAX_REQUESTS()}`,
  );

  let processed = 0;
  for (const symbol of symbols) {
    processed++;
    let lastStatus: 'skipped' | 'fetched' | 'failed' = 'failed';

    try {
      const result = await updateOneSymbol(symbol, { targetTradingDay, minBars, dryRun });
      lastStatus = result.status;

      if (result.status === 'skipped') {
        summary.skippedAlreadyUpdated++;
      } else if (result.status === 'fetched') {
        summary.fetched++;
        summary.candlesInserted += result.inserted;
        summary.candlesUpdated += result.updated;
        console.log(
          `[CANDLE DAILY UPDATE] ${symbol} fetched inserted=${result.inserted} ` +
          `updated=${result.updated}`,
        );
        if (maxFetch != null && maxFetch > 0 && summary.fetched >= maxFetch) {
          summary.deferredRemaining = symbols.length - processed;
          console.warn(
            `[CANDLE DAILY UPDATE] max_fetch=${maxFetch} reached — ` +
            `${summary.deferredRemaining} symbols remaining`,
          );
          break;
        }
      } else {
        summary.failed++;
        summary.failures.push({ symbol, reason: result.reason ?? 'unknown' });
        console.warn(`[CANDLE DAILY UPDATE] ${symbol} failed: ${result.reason}`);
        const abort = isAbortReason(result.reason);
        if (abort) {
          summary.deferredRemaining = symbols.length - processed;
          console.warn(
            `[CANDLE DAILY UPDATE] stopping early (${abort}) — ` +
            `${summary.deferredRemaining} symbols deferred`,
          );
          break;
        }
      }
    } catch (err) {
      summary.failed++;
      const reason = err instanceof Error ? err.message : String(err);
      summary.failures.push({ symbol, reason });
      console.warn(`[CANDLE DAILY UPDATE] ${symbol} error: ${reason}`);
    }

    if (processed % 50 === 0 || processed === symbols.length) {
      console.log(
        `[CANDLE DAILY UPDATE] progress ${processed}/${symbols.length} ` +
        `skipped=${summary.skippedAlreadyUpdated} fetched=${summary.fetched} ` +
        `failed=${summary.failed} requests=${getKiteCandleRequestCount()}`,
      );
    }

    if (!dryRun && processed < symbols.length && lastStatus === 'fetched') {
      await sleep(requestDelayMs);
    }
  }

  summary.requestsUsed = getKiteCandleRequestCount();
  summary.latestCandleDate = dryRun
    ? summary.latestCandleDate
    : await queryGlobalLatestCandleDate();
  summary.durationMs = Date.now() - t0;

  console.log('[CANDLE DAILY UPDATE] complete', {
    ...summary,
    failures: summary.failures.length <= 10
      ? summary.failures
      : [...summary.failures.slice(0, 10), { symbol: '...', reason: `+${summary.failures.length - 10} more` }],
  });

  return summary;
}
