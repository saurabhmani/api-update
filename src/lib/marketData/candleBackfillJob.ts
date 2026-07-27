// ════════════════════════════════════════════════════════════════
//  Candle Backfill Job — Kite → `candles` warehouse
//
//  Backfills daily EOD bars for active NSE symbols from q365_universe.
//  Writes ONLY to the `candles` table (instrument_key + eod + 1day).
//  `market_data_daily` is a VIEW over `candles` — never written here.
//
//  Usage:
//    import { runCandleBackfillJob } from '@/lib/marketData/candleBackfillJob';
//    const summary = await runCandleBackfillJob();
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import {
  fetchUpstreamDailyCandles,
  getKiteCandleRequestCount,
  resetCandleSourceCounters,
} from '@/lib/marketData/candleFallbackChain';
import {
  fetchNseHistoricalCandles,
  isNseHistoricalFetchEnabled,
} from '@/lib/marketData/providers/nseHistoricalProvider';
import { assertQuotaForJob } from '@/lib/marketData/providerRequestLog';
import { runWithProviderRequestContext } from '@/lib/marketData/providerRequestContext';
import {
  resolveBackfillMaxFetch,
  resolveBackfillPerRunLimit,
} from '@/lib/marketData/providerRequestPolicy';

// ── Config ────────────────────────────────────────────────────────

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(raw)));
}

export const BACKFILL_MIN_BARS_DEFAULT = () =>
  envNum('CANDLE_BACKFILL_MIN_BARS', 50, 500, 240);

export const BACKFILL_UNIVERSE_LIMIT_DEFAULT = () =>
  envNum('CANDLE_BACKFILL_UNIVERSE_LIMIT', 1, 5000, 2500);

/** Max calendar age of latest bar to consider history "recent enough". */
export const BACKFILL_MAX_AGE_DAYS_DEFAULT = () =>
  envNum('CANDLE_BACKFILL_MAX_AGE_DAYS', 1, 30, 7);

/** Pause between upstream calls (ms). */
export const BACKFILL_REQUEST_DELAY_MS_DEFAULT = () =>
  envNum('CANDLE_BACKFILL_REQUEST_DELAY_MS', 200, 10_000, 800);

/** Extra backoff after RATE_LIMITED (ms). */
const RATE_LIMIT_BACKOFF_MS = () =>
  envNum('CANDLE_BACKFILL_RATE_LIMIT_BACKOFF_MS', 1_000, 120_000, 15_000);

const CANDLE_TYPE = 'eod' as const;
const INTERVAL_UNIT = '1day' as const;

function instrumentKey(symbol: string): string {
  return `NSE_EQ|${symbol.toUpperCase()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Types ─────────────────────────────────────────────────────────

export type BackfillSymbolSource = 'q365_universe' | 'securities_master';

export interface CandleBackfillJobOptions {
  /** Max active symbols from the chosen source. Default 1000. */
  universeLimit?: number;
  /** Symbol pool — q365_universe (default) or securities_master EQ. */
  symbolSource?: BackfillSymbolSource;
  /** Skip upstream when bar count >= this and latest is recent. Default 240. */
  minBars?: number;
  /** Latest bar must be newer than this many calendar days. Default 7. */
  maxAgeDays?: number;
  /** Delay between upstream requests (ms). Default 800. */
  requestDelayMs?: number;
  /** Log plan only — no provider or DB writes. */
  dryRun?: boolean;
  /** Only symbols below minBars or with stale latest (zero API on skips). */
  resume?: boolean;
  /** Stop after this many successful fetches (quota-safe batching). */
  maxFetch?: number;
  /** Optional symbol subset (uppercased); still capped by universeLimit. */
  symbols?: string[];
}

export interface SymbolBackfillFailure {
  symbol: string;
  reason: string;
}

export interface UniverseBackfillStats {
  universeTotal: number;
  alreadySufficient: number;
  needingBackfill: number;
}

export interface CandleBackfillJobSummary {
  totalSymbols: number;
  /** Active universe size (q365_universe), regardless of resume queue. */
  universeTotal: number;
  /** Symbols with enough fresh bars — no API call needed this campaign. */
  alreadySufficient: number;
  skippedSufficient: number;
  fetched: number;
  failed: number;
  /** Symbols not attempted because per-run upstream budget was exhausted. */
  deferredDueToBudget: number;
  candlesInserted: number;
  candlesUpdated: number;
  /** Kite historical requests used this run (field name kept for summary shape). */
  upstreamVendor: number;
  failures: SymbolBackfillFailure[];
  durationMs: number;
  dryRun: boolean;
}

const PER_RUN_BUDGET_REASON = 'PER_RUN_LIMIT_EXCEEDED';

const UPSTREAM_ABORT_THRESHOLD = () =>
  envNum('CANDLE_BACKFILL_UPSTREAM_ABORT', 3, 25, 5);

function isUpstreamOutage(reason: string | undefined): boolean {
  if (!reason) return false;
  return (
    reason.includes('provider status=failed')
    || reason.includes('UPSTREAM_ERROR')
    || reason.includes('EMPTY_RESPONSE')
    || reason.includes('HTTP_5')
    || reason.includes('tripped')
  );
}

function isAbortReason(reason: string | undefined): 'budget' | 'auth' | 'upstream' | null {
  if (!reason) return null;
  if (
    reason.includes(PER_RUN_BUDGET_REASON)
    || reason.includes('API_BUDGET_EXCEEDED')
    || reason.includes('per-run budget exhausted')
  ) return 'budget';
  if (
    reason.includes('AUTH_FAILED')
    || reason.includes('API_KEY_INVALID')
    || reason.includes('API key is invalid')
    || reason.includes('status code 403')
  ) return 'auth';
  return null;
}

function isPerRunBudgetExhausted(): boolean {
  return false;
}

function perRunBudgetFailureReason(): string {
  return PER_RUN_BUDGET_REASON;
}

interface SymbolCandleStats {
  barCount: number;
  latestTs: Date | null;
  ageDays: number | null;
}

// ── Universe + stats ──────────────────────────────────────────────

function resolveSymbolSource(options: Pick<CandleBackfillJobOptions, 'symbolSource'>): BackfillSymbolSource {
  return options.symbolSource === 'securities_master' ? 'securities_master' : 'q365_universe';
}

async function loadSecuritiesMasterEqCount(): Promise<number> {
  const { rows } = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM securities_master WHERE is_active = 1 AND series = 'EQ'`,
  );
  return Number((rows[0] as { cnt?: number })?.cnt ?? 0);
}

/** Resolve pool size — securities_master uses full EQ count when limit covers it. */
async function resolveBackfillPoolLimit(
  source: BackfillSymbolSource,
  limit: number,
): Promise<number> {
  if (source !== 'securities_master') return limit;
  const eqCount = await loadSecuritiesMasterEqCount();
  return eqCount > 0 ? Math.max(limit, eqCount) : limit;
}

const BACKFILL_QUEUE_ORDER_UNIVERSE = `COALESCE(d.bar_count, 0) DESC, u.symbol ASC`;
const BACKFILL_QUEUE_ORDER_MASTER = `COALESCE(liq.traded_value, 0) DESC, COALESCE(d.bar_count, 0) ASC, u.symbol ASC`;

async function loadBackfillSymbolPool(
  source: BackfillSymbolSource,
  limit: number,
): Promise<string[]> {
  const poolLimit = await resolveBackfillPoolLimit(source, limit);
  if (source === 'securities_master') {
    const { rows } = await db.query<{ symbol: string }>(
      `SELECT symbol
         FROM securities_master
        WHERE is_active = 1 AND series = 'EQ'
        ORDER BY symbol ASC
        LIMIT ?`,
      [poolLimit],
    );
    return (rows as Array<{ symbol: string }>)
      .map((r) => String(r.symbol).toUpperCase().trim())
      .filter(Boolean);
  }
  return loadActiveUniverseSymbols(limit);
}

export async function loadActiveUniverseSymbols(limit: number): Promise<string[]> {
  const { rows } = await db.query<{ symbol: string }>(
    `SELECT symbol
       FROM q365_universe
      WHERE is_active = 1
      ORDER BY symbol ASC
      LIMIT ?`,
    [limit],
  );
  return (rows as Array<{ symbol: string }>)
    .map((r) => String(r.symbol).toUpperCase().trim())
    .filter(Boolean);
}

/**
 * Active universe symbols that still need a historical fetch (thin or stale).
 * Use with `resume: true` to avoid iterating symbols that would skip anyway.
 */
/**
 * One SQL round-trip for universe coverage — avoids N per-symbol stats queries.
 */
export async function getUniverseBackfillStats(
  limit: number,
  minBars: number,
  maxAgeDays: number,
  symbolSource: BackfillSymbolSource = 'q365_universe',
): Promise<UniverseBackfillStats> {
  const poolLimit = await resolveBackfillPoolLimit(symbolSource, limit);
  const poolSql = symbolSource === 'securities_master'
    ? `SELECT symbol
         FROM securities_master
        WHERE is_active = 1 AND series = 'EQ'
        ORDER BY symbol ASC
        LIMIT ?`
    : `SELECT symbol
         FROM q365_universe
        WHERE is_active = 1
        ORDER BY symbol ASC
        LIMIT ?`;

  const { rows } = await db.query<{
    universe_total: number;
    already_sufficient: number;
    needing_backfill: number;
  }>(
    `SELECT
       COUNT(*) AS universe_total,
       SUM(
         CASE
           WHEN d.bar_count >= ?
            AND d.latest_ts IS NOT NULL
            AND TIMESTAMPDIFF(DAY, d.latest_ts, UTC_TIMESTAMP()) <= ?
           THEN 1 ELSE 0
         END
       ) AS already_sufficient,
       SUM(
         CASE
           WHEN d.bar_count IS NULL
            OR d.bar_count < ?
            OR d.latest_ts IS NULL
            OR TIMESTAMPDIFF(DAY, d.latest_ts, UTC_TIMESTAMP()) > ?
           THEN 1 ELSE 0
         END
       ) AS needing_backfill
     FROM (
       ${poolSql}
     ) u
     LEFT JOIN (
       SELECT symbol, COUNT(*) AS bar_count, MAX(ts) AS latest_ts
         FROM market_data_daily
        GROUP BY symbol
     ) d ON d.symbol COLLATE utf8mb4_unicode_ci = u.symbol COLLATE utf8mb4_unicode_ci`,
    [minBars, maxAgeDays, minBars, maxAgeDays, poolLimit],
  );
  const row = (rows[0] as {
    universe_total?: number;
    already_sufficient?: number;
    needing_backfill?: number;
  }) ?? {};
  return {
    universeTotal: Number(row.universe_total) || 0,
    alreadySufficient: Number(row.already_sufficient) || 0,
    needingBackfill: Number(row.needing_backfill) || 0,
  };
}

export async function loadSymbolsNeedingBackfill(
  limit: number,
  minBars: number,
  maxAgeDays: number,
  symbolSource: BackfillSymbolSource = 'q365_universe',
): Promise<string[]> {
  const poolLimit = await resolveBackfillPoolLimit(symbolSource, limit);
  const fromClause = symbolSource === 'securities_master'
    ? `securities_master u`
    : `q365_universe u`;
  const activeFilter = symbolSource === 'securities_master'
    ? `u.is_active = 1 AND u.series = 'EQ'`
    : `u.is_active = 1`;

  const queueOrder = symbolSource === 'securities_master'
    ? BACKFILL_QUEUE_ORDER_MASTER
    : BACKFILL_QUEUE_ORDER_UNIVERSE;

  const liquidityJoin = symbolSource === 'securities_master'
    ? `LEFT JOIN (
         SELECT SUBSTRING_INDEX(instrument_key, '|', -1) AS symbol,
                COALESCE(SUM(volume * close), 0) AS traded_value
           FROM candles
          WHERE candle_type = 'eod' AND interval_unit = '1day'
            AND ts >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)
          GROUP BY instrument_key
       ) liq ON liq.symbol COLLATE utf8mb4_unicode_ci = u.symbol COLLATE utf8mb4_unicode_ci`
    : '';

  const { rows } = await db.query<{ symbol: string }>(
    `SELECT u.symbol
       FROM ${fromClause}
       ${liquidityJoin}
       LEFT JOIN (
         SELECT symbol, COUNT(*) AS bar_count, MAX(ts) AS latest_ts
           FROM market_data_daily
          GROUP BY symbol
       ) d ON d.symbol COLLATE utf8mb4_unicode_ci = u.symbol COLLATE utf8mb4_unicode_ci
      WHERE ${activeFilter}
        AND (
          d.bar_count IS NULL
          OR d.bar_count < ?
          OR d.latest_ts IS NULL
          OR TIMESTAMPDIFF(DAY, d.latest_ts, UTC_TIMESTAMP()) > ?
        )
      ORDER BY ${queueOrder}
      LIMIT ?`,
    [minBars, maxAgeDays, poolLimit],
  );
  return (rows as Array<{ symbol: string }>)
    .map((r) => String(r.symbol).toUpperCase().trim())
    .filter(Boolean);
}

/**
 * Read bar count + freshness via market_data_daily (view over candles).
 */
export async function getSymbolCandleStats(symbol: string): Promise<SymbolCandleStats> {
  try {
    const { rows } = await db.query<{ cnt: number; latest: Date | string | null }>(
      `SELECT COUNT(*) AS cnt, MAX(ts) AS latest
         FROM market_data_daily
        WHERE symbol = ?`,
      [symbol.toUpperCase()],
    );
    const row = (rows[0] as { cnt?: number; latest?: Date | string | null }) ?? {};
    const barCount = Number(row.cnt) || 0;
    const latestRaw = row.latest;
    const latestTs = latestRaw instanceof Date
      ? latestRaw
      : (latestRaw ? new Date(latestRaw) : null);
    const ageDays = latestTs && !Number.isNaN(latestTs.getTime())
      ? Math.round((Date.now() - latestTs.getTime()) / 86_400_000 * 10) / 10
      : null;
    return { barCount, latestTs, ageDays };
  } catch {
    return { barCount: 0, latestTs: null, ageDays: null };
  }
}

function shouldSkipSymbol(
  stats: SymbolCandleStats,
  minBars: number,
  maxAgeDays: number,
): boolean {
  if (stats.barCount < minBars) return false;
  if (stats.ageDays == null) return false;
  return stats.ageDays <= maxAgeDays;
}

// ── Upsert with insert/update tracking (source-aware, Phase 13) ───

async function upsertDailyCandle(
  symbol: string,
  ts: Date,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
  source: 'kite' | 'nse_bhavcopy' | 'yahoo' | 'shoonya' = 'kite',
): Promise<'inserted' | 'updated' | 'unchanged' | 'skipped'> {
  const { upsertWarehouseCandle } = await import('@/lib/marketData/jobs/candleWarehouseUpsert');
  return upsertWarehouseCandle({
    instrumentKey: instrumentKey(symbol),
    candleType: CANDLE_TYPE,
    intervalUnit: INTERVAL_UNIT,
    ts,
    open,
    high,
    low,
    close,
    volume,
    source,
  });
}

export async function persistBarsForSymbol(
  symbol: string,
  bars: Array<{ ts: string | Date; open: number; high: number; low: number; close: number; volume: number }>,
  source: 'kite' | 'nse_bhavcopy' | 'yahoo' | 'shoonya' = 'kite',
): Promise<{ inserted: number; updated: number; skipped: number }> {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  for (const bar of bars) {
    const ts = bar.ts instanceof Date ? bar.ts : new Date(bar.ts);
    if (Number.isNaN(ts.getTime())) continue;
    if (
      !Number.isFinite(bar.open) || !Number.isFinite(bar.high)
      || !Number.isFinite(bar.low) || !Number.isFinite(bar.close)
    ) continue;

    const outcome = await upsertDailyCandle(
      symbol,
      ts,
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      Number.isFinite(bar.volume) ? bar.volume : 0,
      source,
    );
    if (outcome === 'inserted') inserted++;
    else if (outcome === 'updated') updated++;
    else if (outcome === 'skipped') skipped++;
  }
  return { inserted, updated, skipped };
}

// ── Per-symbol backfill ───────────────────────────────────────────

async function backfillOneSymbol(
  symbol: string,
  opts: {
    minBars: number;
    maxAgeDays: number;
    dryRun: boolean;
  },
): Promise<{
  status: 'skipped' | 'fetched' | 'failed';
  inserted: number;
  updated: number;
  reason?: string;
}> {
  const stats = await getSymbolCandleStats(symbol);
  if (shouldSkipSymbol(stats, opts.minBars, opts.maxAgeDays)) {
    return {
      status: 'skipped',
      inserted: 0,
      updated: 0,
      reason: `sufficient: bars=${stats.barCount} age_days=${stats.ageDays}`,
    };
  }

  if (opts.dryRun) {
    return {
      status: 'fetched',
      inserted: 0,
      updated: 0,
      reason: `dry_run: would_fetch bars=${stats.barCount} min=${opts.minBars}`,
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

  let fetch = await fetchUpstreamDailyCandles(symbol, '1y');
  const isRetryable = (code: string | null | undefined) =>
    code === 'RATE_LIMITED'
    || code === 'API_KEY_INVALID'
    || code === 'KiteRateLimitError'
    || code === 'KiteAuthenticationError';
  if (!fetch.ok && isRetryable(fetch.errorCode)) {
    const backoffMs = (
      fetch.errorCode === 'RATE_LIMITED' || fetch.errorCode === 'KiteRateLimitError'
    )
      ? RATE_LIMIT_BACKOFF_MS()
      : 60_000;
    console.warn(
      `[CANDLE BACKFILL] ${symbol} ${fetch.errorCode} — sleeping ${backoffMs}ms then one retry`,
    );
    await sleep(backoffMs);
    fetch = await fetchUpstreamDailyCandles(symbol, '1y');
  }

  if (!fetch.ok || fetch.candles.length === 0) {
    if (isNseHistoricalFetchEnabled()) {
      const nse = await fetchNseHistoricalCandles(symbol);
      if (nse.ok && nse.candles.length > 0) {
        const { inserted, updated } = await persistBarsForSymbol(
          symbol,
          nse.candles,
          'nse_bhavcopy',
        );
        if (inserted > 0 || updated > 0) {
          console.log(
            `[CANDLE BACKFILL] ${symbol} nse_fallback bars=${nse.candles.length} ` +
            `inserted=${inserted} updated=${updated}`,
          );
          return { status: 'fetched', inserted, updated };
        }
      }
    }
    return {
      status: 'failed',
      inserted: 0,
      updated: 0,
      reason: fetch.errorMessage ?? String(fetch.errorCode ?? 'fetch_failed'),
    };
  }

  const { inserted, updated } = await persistBarsForSymbol(
    symbol,
    fetch.candles,
    (fetch as { warehouseSource?: 'kite' | 'shoonya' }).warehouseSource === 'shoonya'
      ? 'shoonya'
      : 'kite',
  );
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

// ── Main job ──────────────────────────────────────────────────────

export async function estimateBackfillApiRequests(
  options: Pick<
    CandleBackfillJobOptions,
    'universeLimit' | 'minBars' | 'maxAgeDays' | 'resume' | 'symbols' | 'maxFetch' | 'symbolSource'
  > = {},
): Promise<number> {
  const universeLimit = options.universeLimit ?? BACKFILL_UNIVERSE_LIMIT_DEFAULT();
  const minBars = options.minBars ?? BACKFILL_MIN_BARS_DEFAULT();
  const maxAgeDays = options.maxAgeDays ?? BACKFILL_MAX_AGE_DAYS_DEFAULT();
  const symbolSource = resolveSymbolSource(options);

  const symbols = options.symbols?.length
    ? options.symbols.map((s) => s.toUpperCase()).slice(0, universeLimit)
    : options.resume
      ? await loadSymbolsNeedingBackfill(universeLimit, minBars, maxAgeDays, symbolSource)
      : await loadBackfillSymbolPool(symbolSource, universeLimit);

  let wouldFetch = 0;
  for (const symbol of symbols) {
    const stats = await getSymbolCandleStats(symbol);
    if (!shouldSkipSymbol(stats, minBars, maxAgeDays)) {
      wouldFetch++;
      if (options.maxFetch != null && options.maxFetch > 0 && wouldFetch >= options.maxFetch) {
        break;
      }
    }
  }
  return wouldFetch;
}

export async function runCandleBackfillJob(
  options: CandleBackfillJobOptions = {},
): Promise<CandleBackfillJobSummary> {
  const t0 = Date.now();
  const universeLimit = options.universeLimit ?? BACKFILL_UNIVERSE_LIMIT_DEFAULT();
  const minBars = options.minBars ?? BACKFILL_MIN_BARS_DEFAULT();
  const maxAgeDays = options.maxAgeDays ?? BACKFILL_MAX_AGE_DAYS_DEFAULT();
  const requestDelayMs = options.requestDelayMs ?? BACKFILL_REQUEST_DELAY_MS_DEFAULT();
  const dryRun = options.dryRun ?? false;
  const maxFetch = resolveBackfillMaxFetch({
    resume: options.resume,
    maxFetch: options.maxFetch,
    symbols: options.symbols,
  });

  if (!dryRun) {
    const { ensureCandleIngestConfigured } = await import(
      '@/lib/marketData/jobs/candleIngestBroker'
    );
    const gate = await ensureCandleIngestConfigured();
    if (!gate.ok) {
      throw new Error(
        gate.message
        || 'No connected broker for candle ingest — connect Shoonya or Zerodha on /data-source',
      );
    }
    console.log(`[CANDLE BACKFILL] ingest=${gate.message}`);
  }

  const jobId = `candle-backfill_${Date.now()}`;
  if (!dryRun) {
    const estimate = await estimateBackfillApiRequests({
      ...options,
      maxFetch,
    });
    await assertQuotaForJob({
      estimatedRequests: estimate,
      jobId,
      sourceJob: 'candle-backfill',
    });
  }

  return runWithProviderRequestContext(
    { jobId, sourceJob: 'candle-backfill', requestType: 'historical_daily' },
    async () => runCandleBackfillJobInner({
      t0,
      universeLimit,
      minBars,
      maxAgeDays,
      requestDelayMs,
      dryRun,
      maxFetch,
      options,
    }),
  );
}

async function runCandleBackfillJobInner(ctx: {
  t0: number;
  universeLimit: number;
  minBars: number;
  maxAgeDays: number;
  requestDelayMs: number;
  dryRun: boolean;
  maxFetch?: number;
  options: CandleBackfillJobOptions;
}): Promise<CandleBackfillJobSummary> {
  const {
    t0, universeLimit, minBars, maxAgeDays, requestDelayMs, dryRun, maxFetch, options,
  } = ctx;

  resetCandleSourceCounters();
  const perRunLimit = resolveBackfillPerRunLimit({
    resume: options.resume,
    maxFetch,
    symbols: options.symbols,
  });



  const symbolSource = resolveSymbolSource(options);

  const universeStats = options.symbols?.length
    ? null
    : await getUniverseBackfillStats(universeLimit, minBars, maxAgeDays, symbolSource);

  const symbols = options.symbols?.length
    ? options.symbols.map((s) => s.toUpperCase()).slice(0, universeLimit)
    : options.resume
      ? await loadSymbolsNeedingBackfill(universeLimit, minBars, maxAgeDays, symbolSource)
      : await loadBackfillSymbolPool(symbolSource, universeLimit);

  const summary: CandleBackfillJobSummary = {
    totalSymbols: symbols.length,
    universeTotal: universeStats?.universeTotal ?? symbols.length,
    alreadySufficient: universeStats?.alreadySufficient ?? 0,
    skippedSufficient: 0,
    fetched: 0,
    failed: 0,
    deferredDueToBudget: 0,
    candlesInserted: 0,
    candlesUpdated: 0,
    upstreamVendor: 0,
    failures: [],
    durationMs: 0,
    dryRun,
  };

  const symbolsAttempted = summary.universeTotal;
  console.log(
    `[CANDLE BACKFILL] start source=${symbolSource} universe=${summary.universeTotal} ` +
    `already_sufficient=${summary.alreadySufficient} queue=${symbols.length} ` +
    `symbols_attempted=${symbolsAttempted} min_bars=${minBars} ` +
    `max_age_days=${maxAgeDays} delay_ms=${requestDelayMs} dry_run=${dryRun} ` +
    `resume=${options.resume ?? false} max_fetch=${maxFetch ?? 'none'} ` +
    `per_run_limit=${perRunLimit}`,
  );

  // Plan-only full-universe dry-run: one SQL stats query, zero per-symbol DB walks.
  if (
    dryRun
    && !options.symbols?.length
    && !options.resume
    && universeStats
  ) {
    summary.skippedSufficient = universeStats.alreadySufficient;
    summary.fetched = universeStats.needingBackfill;
    summary.durationMs = Date.now() - t0;
    console.log('[CANDLE BACKFILL] complete', {
      ...summary,
      failures: [],
      per_run_budget: null,
      plan_note: 'dry_run full-universe plan via SQL (no per-symbol iteration)',
    });
    return summary;
  }

  let processed = 0;
  let consecutiveUpstreamFailures = 0;
  for (const symbol of symbols) {
    processed++;
    let lastStatus: 'skipped' | 'fetched' | 'failed' = 'failed';
    try {
      const result = await backfillOneSymbol(symbol, { minBars, maxAgeDays, dryRun });
      lastStatus = result.status;

      if (result.status === 'skipped') {
        summary.skippedSufficient++;
      } else if (result.status === 'fetched') {
        consecutiveUpstreamFailures = 0;
        summary.fetched++;
        summary.candlesInserted += result.inserted;
        summary.candlesUpdated += result.updated;
        console.log(
          `[CANDLE BACKFILL] ${symbol} fetched inserted=${result.inserted} ` +
          `updated=${result.updated}`,
        );
        if (maxFetch != null && maxFetch > 0 && summary.fetched >= maxFetch) {
          summary.deferredDueToBudget = symbols.length - processed;
          console.warn(
            `[CANDLE BACKFILL] max_fetch=${maxFetch} reached — stopping ` +
            `(${summary.deferredDueToBudget} symbols remaining; re-run --resume to continue)`,
          );
          break;
        }
      } else {
        summary.failed++;
        summary.failures.push({ symbol, reason: result.reason ?? 'unknown' });
        console.warn(`[CANDLE BACKFILL] ${symbol} failed: ${result.reason}`);
        const abort = isAbortReason(result.reason);
        if (abort === 'budget') {
          summary.deferredDueToBudget = symbols.length - processed;
          console.warn(
            `[CANDLE BACKFILL] per-run budget exhausted — stopping early ` +
            `(${summary.deferredDueToBudget} symbols deferred; ` +
            `raise per-run limit ≥${symbols.length} and re-run)`,
          );
          break;
        }
        if (abort === 'auth') {
          // Per-symbol auth failure — continue queue to avoid deferring the whole batch.
          // backfillOneSymbol already slept + retried once; skip burns no extra API quota.
          console.warn(
            `[CANDLE BACKFILL] ${symbol} auth rejected after retry — skipping ` +
            `(verify Kite credentials if failures cluster)`,
          );
        } else if (isUpstreamOutage(result.reason)) {
          consecutiveUpstreamFailures++;
          const threshold = UPSTREAM_ABORT_THRESHOLD();
          if (consecutiveUpstreamFailures >= threshold) {
            summary.deferredDueToBudget = symbols.length - processed;
            console.error(
              `[CANDLE BACKFILL] upstream outage — ${consecutiveUpstreamFailures} consecutive ` +
              `failures (e.g. "${result.reason?.slice(0, 80)}"). Aborting to preserve API quota. ` +
              `Run: npm run candles:backfill:preflight`,
            );
            break;
          }
        } else {
          consecutiveUpstreamFailures = 0;
        }
      }
    } catch (err) {
      summary.failed++;
      const reason = err instanceof Error ? err.message : String(err);
      summary.failures.push({ symbol, reason });
      console.warn(`[CANDLE BACKFILL] ${symbol} error: ${reason}`);
    }

    if (processed % 25 === 0 || processed === symbols.length) {
      console.log(
        `[CANDLE BACKFILL] progress ${processed}/${symbols.length} ` +
        `skipped=${summary.skippedSufficient} fetched=${summary.fetched} ` +
        `failed=${summary.failed} kite_requests=${getKiteCandleRequestCount()}`,
      );
    }

    if (!dryRun && processed < symbols.length && lastStatus !== 'skipped') {
      await sleep(requestDelayMs);
    }
  }

  const budget = null;
  summary.upstreamVendor = getKiteCandleRequestCount();
  summary.durationMs = Date.now() - t0;

  console.log('[CANDLE BACKFILL] complete', {
    ...summary,
    failures: summary.failures.length <= 10
      ? summary.failures
      : [...summary.failures.slice(0, 10), { symbol: '...', reason: `+${summary.failures.length - 10} more` }],
    per_run_budget: budget,
  });

  return summary;
}
