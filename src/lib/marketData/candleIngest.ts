/**
 * Daily OHLC ingest — Yahoo Finance only. // @deprecated marker
 *
 * Why this file exists
 * ────────────────────
 * The signal engine reads daily bars from the `market_data_daily`
 * view (which projects the underlying `candles` table). This module
 * is the single writer: it pulls fresh day-bars from Yahoo, upserts // @deprecated marker
 * them into `candles`, and returns a structured summary the caller
 * can log.
 *
 * Design
 *   - Yahoo Finance is the sole historical upstream. Real-time // @deprecated marker
 *     pricing is served by Kite WebSocket ticks — never mixed with // @deprecated marker
 *     historical ingest.
 *   - Bulk refresh is bounded by INGEST_CONCURRENCY (default 6).
 *     A per-symbol failure never stops the run — the loop just
 *     records the reason and moves on.
 *   - `force` mode re-fetches every symbol regardless of DB age.
 *     `/api/run-signal-engine` always passes `force: true` so every
 *     pipeline run starts from fresh upstream bars.
 */

import { getCandles } from './getCandles';
import type { OhlcBar, CandleSource } from './getCandles';
import { persistCandle } from '@/services/marketDataService';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { DEFAULT_PHASE1_CONFIG } from '@/lib/signal-engine/constants/signalEngine.constants';

const log = logger.child({ component: 'candleIngest' });

// ── Config ──────────────────────────────────────────────────────

// Default 6 historically. Drops to 2 when YAHOO_GLOBAL_LIMITER=true
// so the nightly candle refresh doesn't dominate the global bucket
// during a daytime overlap. Explicit env value still wins.
const INGEST_CONCURRENCY = Math.max(1, (() => {
  const raw = Number(process.env.CANDLE_INGEST_CONCURRENCY);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return process.env.YAHOO_GLOBAL_LIMITER === 'true' ? 2 : 6;
})());

const DEFAULT_MAX_AGE_HOURS =
  Number(process.env.CANDLE_INGEST_MAX_AGE_HOURS) || 3;

// ── Types ───────────────────────────────────────────────────────

export interface RefreshCandlesOptions {
  /** Universe to refresh. Required — caller passes the symbols the
   *  signal engine actually reads so we don't touch the whole market. */
  symbols:      string[];
  /** A symbol is considered stale if its newest bar is older than
   *  this many hours. Default 3h. Only used when `force` is false. */
  maxAgeHours?: number;
  /** If true, refresh every symbol regardless of current freshness.
   *  Run-time "Run Pipeline" used to always set this to true; per
   *  spec "OPTIMIZE API USAGE PER RUN" §1, the route now overlays
   *  `freshIfWithinMinutes` so even a forced refresh skips symbols
   *  whose stored bars were updated in the last few minutes. */
  force?:       boolean;
  /** Spec "OPTIMIZE API USAGE PER RUN" §1 — short-circuit per
   *  symbol when the stored latest bar is younger than this many
   *  minutes. Applied EVEN when `force=true`; daily bars only update
   *  once per session, so re-fetching a symbol whose `latest_ts`
   *  ticked 5 minutes ago burns budget for zero new data. Default
   *  read from env `CANDLE_FRESH_IF_WITHIN_MIN` (default 10). */
  freshIfWithinMinutes?: number;
  /** Bypass the per-cycle MAX_PER_CYCLE cap. ONLY the 09:25 IST
   *  pre-open warmup is permitted to set this. Every other caller
   *  (15-min scheduler, run-pipeline) MUST leave it false so the
   *  100-symbol cap protects the budget. */
  noCap?:       boolean;
}

export interface RefreshCandlesResult {
  requested:      number;
  staleCount:     number;
  refreshed:      number;
  barsIngested:   number;
  unresolved:     string[];
  failed:         Array<{ symbol: string; reason: string }>;
  latestTsBefore: string | null;
  latestTsAfter:  string | null;
  ageHoursBefore: number | null;
  ageHoursAfter:  number | null;
  durationMs:     number;
}

// ── Internal helpers ───────────────────────────────────────────

interface LatestRow {
  symbol:    string;
  latestTs:  Date | null;
  ageHours:  number | null;
}

async function fetchLatestTsPerSymbol(symbols: string[]): Promise<LatestRow[]> {
  if (symbols.length === 0) return [];

  const instrumentKeys = symbols.map((s) => `NSE_EQ|${s.toUpperCase()}`);
  const placeholders   = instrumentKeys.map(() => '?').join(',');

  const { rows } = await db.query(
    `SELECT instrument_key, MAX(ts) AS latest
       FROM candles
      WHERE candle_type   = 'eod'
        AND interval_unit = '1day'
        AND instrument_key IN (${placeholders})
      GROUP BY instrument_key`,
    instrumentKeys,
  );

  const byKey = new Map<string, Date>();
  for (const r of rows as Array<{ instrument_key: string; latest: Date | string }>) {
    if (r.latest) byKey.set(r.instrument_key, new Date(r.latest));
  }

  const now = Date.now();
  return symbols.map((sym) => {
    const key      = `NSE_EQ|${sym.toUpperCase()}`;
    const latest   = byKey.get(key) ?? null;
    const ageHours = latest ? (now - latest.getTime()) / 3_600_000 : null;
    return { symbol: sym.toUpperCase(), latestTs: latest, ageHours };
  });
}

/**
 * Fetch fresh daily bars for a single symbol from Yahoo and // @deprecated marker
 * upsert them into the `candles` table. Returns `{ written, source }`
 * so the caller can log exactly which upstream served each symbol.
 *
 * Throws only for DB errors — upstream failures resolve to
 * `{ written: 0, source: null }`.
 */
/**
 * Spec "FIX CANDLE INGEST" §2 — fallback to last-known-bar.
 *
 * When IndianAPI's /historical_data fails for a symbol (no_data /
 * timeout / 5xx), check market_data_daily for the most recent stored
 * bars. If we already have a usable history (≥ minBars within
 * maxAgeDays of NOW), the symbol isn't truly broken — it just couldn't
 * be refreshed today. Treating that as a "fallback success" lets the
 * downstream signal engine still score the symbol from stored bars
 * instead of skipping it entirely.
 *
 * NOTE: this never WRITES new bars. It only verifies that existing
 * stored bars are sufficient for the strategy engine.
 */
const FALLBACK_MIN_BARS = Math.max(
  10,
  Number(process.env.CANDLE_FALLBACK_MIN_BARS) || 50,
);
const FALLBACK_MAX_AGE_DAYS = Math.max(
  1,
  Number(process.env.CANDLE_FALLBACK_MAX_AGE_DAYS) || 7,
);

async function checkStoredBarsFallback(symbol: string): Promise<{
  usable:   boolean;
  barCount: number;
  ageDays:  number | null;
}> {
  try {
    const { rows } = await db.query<{ cnt: number; latest: Date | null }>(
      `SELECT COUNT(*) AS cnt, MAX(ts) AS latest
         FROM market_data_daily
        WHERE symbol = ?`,
      [symbol.toUpperCase()],
    );
    const row     = (rows[0] as any) ?? { cnt: 0, latest: null };
    const barCount = Number(row.cnt) || 0;
    const latest   = row.latest instanceof Date
      ? row.latest
      : (row.latest ? new Date(row.latest) : null);
    const ageDays  = latest
      ? Math.round((Date.now() - latest.getTime()) / 86_400_000 * 10) / 10
      : null;
    const usable =
      barCount >= FALLBACK_MIN_BARS &&
      ageDays != null &&
      ageDays <= FALLBACK_MAX_AGE_DAYS;
    return { usable, barCount, ageDays };
  } catch {
    return { usable: false, barCount: 0, ageDays: null };
  }
}

async function ingestOneSymbol(
  symbol: string,
): Promise<{ written: number; source: CandleSource | null; reason?: string; fallback?: boolean }> {
  log.debug('Fetching candles', { symbol });
  const result = await getCandles(symbol);
  if (result.ok !== true) {
    const reason = (result as { reason: string }).reason;
    // Negative-cache hits and the permanent-skip list are expected
    // steady-state noise — log them at debug so a healthy run
    // doesn't flood the terminal. Real upstream failures
    // (timeouts, 5xx, parse errors) stay at warn.
    const isQuiet =
      reason.startsWith('neg_cache:') ||
      reason.startsWith('skip:');
    if (isQuiet) {
      log.debug('Candle fetch skipped (cached)', { symbol, reason });
    } else {
      log.warn('Candle fetch failed', { symbol, reason });
    }

    // Spec §2 — last-known-bar fallback. Skipped for permanent-skip
    // symbols (delisted / non-tradable) since those will never be
    // useful regardless of stored history.
    if (!reason.startsWith('skip:')) {
      const fb = await checkStoredBarsFallback(symbol);
      if (fb.usable) {
        console.log(
          `[CANDLE] fallback used symbol=${symbol} stored_bars=${fb.barCount} age_days=${fb.ageDays} (refresh failed: ${reason})`,
        );
        return {
          written: 0,
          source:  null,
          reason:  `fallback:last_known_bars(${fb.barCount}_bars,${fb.ageDays}d_old)`,
          fallback: true,
        };
      }
      console.log(
        `[CANDLE] no fallback symbol=${symbol} stored_bars=${fb.barCount} age_days=${fb.ageDays ?? 'n/a'} (refresh failed: ${reason})`,
      );
    }
    return { written: 0, source: null, reason };
  }

  const instrumentKey = `NSE_EQ|${symbol.toUpperCase()}`;
  let written = 0;
  const bars: OhlcBar[] = result.candles;

  for (const bar of bars) {
    if (
      !Number.isFinite(bar.open)  ||
      !Number.isFinite(bar.high)  ||
      !Number.isFinite(bar.low)   ||
      !Number.isFinite(bar.close) ||
      !Number.isFinite(bar.ts)
    ) continue;
    await persistCandle(
      instrumentKey,
      'eod',
      '1day',
      new Date(bar.ts),
      bar.open,
      bar.high,
      bar.low,
      bar.close,
      Number.isFinite(bar.volume) ? bar.volume : 0,
      0,
    );
    written++;
  }

  return { written, source: result.source };
}

/**
 * Bounded-concurrency map — avoids pulling a fat dependency just
 * for this one use. `workers` tasks in flight at any moment.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  workers: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function runOne(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, items.length) }, runOne));
  return out;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Refresh daily OHLC bars via Yahoo, scoped to a specific // @deprecated marker
 * universe. With `force: true` every symbol is re-fetched — the
 * "Run Pipeline" path sets that so stale DB bars never leak into a
 * run. Without `force`, only symbols older than `maxAgeHours` are
 * touched (used by background schedulers).
 */
export async function refreshDailyCandles(
  opts: RefreshCandlesOptions,
): Promise<RefreshCandlesResult> {
  const t0          = Date.now();
  // Always include the engine's benchmark symbol — the signal engine
  // aborts with "benchmark snapshot unavailable" if NIFTY 50 daily
  // bars are missing from market_data_daily (see analyzeInstrument's
  // getBenchmarkSnapshot). Centralising the prepend here means every
  // caller (the scheduled refresh + the on-demand /api/run-signal-engine
  // path) stays correct without a duplicated injection. Set-dedupe
  // keeps the symbol exactly once even if a future caller already
  // includes it.
  const symbols     = Array.from(
    new Set(
      [DEFAULT_PHASE1_CONFIG.benchmarkSymbol, ...opts.symbols]
        .map((s) => s.toUpperCase())
        .filter(Boolean),
    ),
  );
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;

  const result: RefreshCandlesResult = {
    requested:      symbols.length,
    staleCount:     0,
    refreshed:      0,
    barsIngested:   0,
    unresolved:     [],
    failed:         [],
    latestTsBefore: null,
    latestTsAfter:  null,
    ageHoursBefore: null,
    ageHoursAfter:  null,
    durationMs:     0,
  };

  if (symbols.length === 0) {
    result.durationMs = Date.now() - t0;
    return result;
  }

  // ── 1. Measure freshness BEFORE ──────────────────────────────
  const beforeRows = await fetchLatestTsPerSymbol(symbols);
  const beforeMax = beforeRows.reduce<Date | null>(
    (acc, r) => (r.latestTs && (!acc || r.latestTs > acc) ? r.latestTs : acc),
    null,
  );
  result.latestTsBefore = beforeMax?.toISOString() ?? null;
  result.ageHoursBefore = beforeMax
    ? Math.round(((Date.now() - beforeMax.getTime()) / 3_600_000) * 10) / 10
    : null;

  // ── 2. Pick the symbols to refresh ───────────────────────────
  //
  // Spec "OPTIMIZE API USAGE PER RUN" §1 — the per-symbol freshness
  // window short-circuits even a forced refresh. Daily bars only
  // update once per market session; once we've fetched today's bar,
  // every subsequent refresh inside the window is wasted budget.
  // With a 10-min window, a 503-symbol manual run after the in-proc
  // 10-min regen has already touched everything drops to ~0 candle
  // calls instead of 503.
  const freshIfWithinMin = (() => {
    if (typeof opts.freshIfWithinMinutes === 'number' && opts.freshIfWithinMinutes >= 0) {
      return opts.freshIfWithinMinutes;
    }
    const raw = Number(process.env.CANDLE_FRESH_IF_WITHIN_MIN);
    if (Number.isFinite(raw) && raw >= 0) return raw;
    return 15;
  })();
  const freshIfWithinHours = freshIfWithinMin / 60;
  let freshSkipCount = 0;
  const toRefresh: LatestRow[] = beforeRows.filter((r) => {
    // Per-symbol freshness skip applies BEFORE the force / staleness
    // branches. A symbol whose last bar was written < freshIfWithinMin
    // ago carries no new info from the upstream and is skipped.
    if (
      freshIfWithinMin > 0
      && r.latestTs != null
      && (r.ageHours ?? Infinity) <= freshIfWithinHours
    ) {
      freshSkipCount++;
      return false;
    }
    if (opts.force) return true;
    if (r.latestTs == null) return true;
    return (r.ageHours ?? Infinity) > maxAgeHours;
  });
  result.staleCount = toRefresh.length;
  if (freshSkipCount > 0) {
    console.log(
      `[CANDLE] freshness-skip ${freshSkipCount}/${beforeRows.length} symbols ` +
      `(latest_ts within ${freshIfWithinMin} min — re-fetch would burn budget for no new data)`,
    );
  }

  // Spec "OPTIMIZE API USAGE PER RUN" §4 — delta-scan filter.
  // Opt-in via CANDLE_DELTA_SCAN_PCT (e.g. 0.5 = skip symbols whose
  // latest stored bar moved <0.5% vs the prior close). Default 0
  // (= disabled) so we don't accidentally hide stable-but-setup-
  // forming names. When enabled, this drops another ~30-50% of the
  // remaining refresh load on quiet days.
  const deltaPct = (() => {
    const raw = Number(process.env.CANDLE_DELTA_SCAN_PCT);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return 0;
  })();
  if (deltaPct > 0 && toRefresh.length > 0) {
    const symList = toRefresh.map((r) => r.symbol);
    const placeholders = symList.map(() => '?').join(',');
    try {
      const { rows: deltaRows } = await db.query<{
        symbol: string; pct_change: number;
      }>(
        `SELECT symbol,
                ABS((latest_close - prior_close) / NULLIF(prior_close, 0)) * 100 AS pct_change
           FROM (
             SELECT
               symbol,
               (ARRAY_AGG(close ORDER BY ts DESC))[1] AS latest_close,
               (ARRAY_AGG(close ORDER BY ts DESC))[2] AS prior_close
             FROM market_data_daily
             WHERE symbol IN (${placeholders})
             GROUP BY symbol
           ) t`,
        symList,
      ).catch(async () => {
        // MySQL has no ARRAY_AGG; emulate with a self-join on the
        // top 2 bars per symbol. Wrapped in a fallback so the same
        // function works on Postgres dev clusters.
        return db.query<{ symbol: string; pct_change: number }>(
          `SELECT a.symbol,
                  ABS((a.close - b.close) / NULLIF(b.close, 0)) * 100 AS pct_change
             FROM (
               SELECT symbol, ts, close,
                      ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts DESC) AS rn
                 FROM market_data_daily
                WHERE symbol IN (${placeholders})
             ) a
             JOIN (
               SELECT symbol, ts, close,
                      ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY ts DESC) AS rn
                 FROM market_data_daily
                WHERE symbol IN (${placeholders})
             ) b ON a.symbol = b.symbol AND a.rn = 1 AND b.rn = 2`,
          [...symList, ...symList],
        );
      });
      const pctBySymbol = new Map<string, number>();
      for (const r of deltaRows as Array<{ symbol: string; pct_change: number }>) {
        const v = Number(r.pct_change);
        if (Number.isFinite(v)) pctBySymbol.set(String(r.symbol).toUpperCase(), v);
      }
      const beforeLen = toRefresh.length;
      // Keep symbols whose latest bar moved >= deltaPct OR for which
      // we have no delta data (so we never hide a fresh listing /
      // missing-bar case behind the filter).
      for (let i = toRefresh.length - 1; i >= 0; i--) {
        const sym = toRefresh[i].symbol.toUpperCase();
        const pct = pctBySymbol.get(sym);
        if (pct != null && pct < deltaPct) {
          toRefresh.splice(i, 1);
        }
      }
      const dropped = beforeLen - toRefresh.length;
      if (dropped > 0) {
        console.log(
          `[CANDLE] delta-scan dropped ${dropped}/${beforeLen} symbols ` +
          `(|d_close| < ${deltaPct}% — quiet stocks, unlikely fresh signal this run)`,
        );
      }
    } catch (err) {
      // Filter is purely an optimization; any DB error means we fall
      // through to the full refresh list. Never block the pipeline.
      console.warn(
        '[CANDLE] delta-scan probe failed — falling back to full refresh:',
        (err as Error)?.message,
      );
    }
  }

  // Step 4(b): hard per-cycle cap. The 15-min ticks during the
  // session must never page through the full universe — that path
  // burned ~58k IndianAPI calls/month. The cap keeps an upper bound
  // even if pickRefreshSubset() returns a larger list than expected.
  const MAX_PER_CYCLE = Math.max(1, Number(process.env.CANDLE_MAX_PER_CYCLE) || 100);
  if (!opts.noCap && toRefresh.length > MAX_PER_CYCLE) {
    log.warn('candle refresh cap engaged', {
      requested: toRefresh.length, capped: MAX_PER_CYCLE,
    });
    toRefresh.length = MAX_PER_CYCLE;
  }

  log.info('Candle refresh starting', {
    universe: symbols.length,
    toRefresh: toRefresh.length,
    latestBefore: result.latestTsBefore ?? 'none',
    ageHoursBefore: result.ageHoursBefore ?? null,
    force: !!opts.force,
  });

  if (toRefresh.length === 0) {
    result.durationMs = Date.now() - t0;
    log.info('Candle refresh skipped — all symbols within cutoff');
    return result;
  }

  // ── 3. Fetch + upsert with bounded concurrency ───────────────
  //
  // Every symbol goes through its own try/catch. A per-symbol
  // failure NEVER aborts the loop, never marks the whole system
  // stale, never throws. This is the "FAIL SAFE" requirement:
  // skip the bad symbol and keep going.
  //
  // Spec — emit a [BATCH] progress log every BATCH_LOG_INTERVAL
  // symbols so the operator can see the scan progressing through the
  // full universe. With INGEST_CONCURRENCY=2 and 503 symbols, the
  // full pass typically takes ~5–15 minutes; without progress logs
  // it looks frozen.
  const BATCH_LOG_INTERVAL = 10;
  const TOTAL_TO_PROCESS = toRefresh.length;
  console.log(`[BATCH] candle refresh starting — total=${TOTAL_TO_PROCESS} concurrency=${INGEST_CONCURRENCY}`);
  let processedCount = 0;
  const bySource: Record<string, number> = { yahoo: 0 }; // @deprecated marker
  let fallbackCount = 0;
  await mapWithConcurrency(toRefresh, INGEST_CONCURRENCY, async (row) => {
    try {
      const { written, source, reason, fallback } = await ingestOneSymbol(row.symbol);
      if (source && written > 0) {
        bySource[source] = (bySource[source] ?? 0) + 1;
        result.refreshed++;
        result.barsIngested += written;
      } else if (fallback) {
        // Refresh failed but stored bars are still usable. Count as
        // "refreshed-equivalent" for the downstream Phase 4 — the
        // symbol HAS bars to score from. Don't add to result.failed[].
        fallbackCount++;
        result.refreshed++;
      } else {
        // Upstream returned no usable bars and no stored fallback.
        // Not a crash — skip.
        log.warn('Candle skip — no bars', { symbol: row.symbol, reason: reason ?? 'unknown' });
        result.failed.push({
          symbol: row.symbol,
          reason: reason ?? 'no bars',
        });
      }
    } catch (err) {
      // Only DB writes reach here — upstream errors are already
      // caught inside getCandles. Log and continue.
      const e = err as Error;
      log.error('Candle ingest failed', new Error(e.message), { symbol: row.symbol });
      result.failed.push({ symbol: row.symbol, reason: e.message });
    }
    // Per-batch progress (every BATCH_LOG_INTERVAL symbols).
    processedCount++;
    if (processedCount % BATCH_LOG_INTERVAL === 0 || processedCount === TOTAL_TO_PROCESS) {
      console.log(
        `[BATCH] ${processedCount}/${TOTAL_TO_PROCESS} candles processed ` +
        `(refreshed=${result.refreshed} fallback=${fallbackCount} failed=${result.failed.length})`,
      );
    }
  });
  console.log(
    `[TOTAL FETCHED] ${result.refreshed}/${TOTAL_TO_PROCESS} candles ` +
    `(live_refreshed=${result.refreshed - fallbackCount} fallback_used=${fallbackCount} failed=${result.failed.length})`,
  );
  if (fallbackCount > 0) {
    console.log(
      `[CANDLE] fallback summary — ${fallbackCount}/${toRefresh.length} symbols served from last-known stored bars`,
    );
  }

  // ── 4. Measure freshness AFTER ───────────────────────────────
  const afterRows = await fetchLatestTsPerSymbol(symbols);
  const afterMax = afterRows.reduce<Date | null>(
    (acc, r) => (r.latestTs && (!acc || r.latestTs > acc) ? r.latestTs : acc),
    null,
  );
  result.latestTsAfter = afterMax?.toISOString() ?? null;
  result.ageHoursAfter = afterMax
    ? Math.round(((Date.now() - afterMax.getTime()) / 3_600_000) * 10) / 10
    : null;

  result.durationMs = Date.now() - t0;

  log.info('Candle refresh complete', {
    durationMs: result.durationMs,
    refreshed: result.refreshed,
    attempted: toRefresh.length,
    barsIngested: result.barsIngested,
    yahoo: bySource.yahoo ?? 0, // @deprecated marker
    failed: result.failed.length,
    latestBefore: result.latestTsBefore ?? 'none',
    ageHoursBefore: result.ageHoursBefore ?? null,
    latestAfter: result.latestTsAfter ?? 'none',
    ageHoursAfter: result.ageHoursAfter ?? null,
  });

  return result;
}
