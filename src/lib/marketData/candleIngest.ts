/**
 * Daily OHLC ingest — Yahoo Finance only.
 *
 * Why this file exists
 * ────────────────────
 * The signal engine reads daily bars from the `market_data_daily`
 * view (which projects the underlying `candles` table). This module
 * is the single writer: it pulls fresh day-bars from Yahoo, upserts
 * them into `candles`, and returns a structured summary the caller
 * can log.
 *
 * Design
 *   - Yahoo Finance is the sole historical upstream. Real-time
 *     pricing is served by Kite WebSocket ticks — never mixed with
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

const log = logger.child({ component: 'candleIngest' });

// ── Config ──────────────────────────────────────────────────────

const INGEST_CONCURRENCY =
  Math.max(1, Number(process.env.CANDLE_INGEST_CONCURRENCY) || 6);

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
   *  Run-time "Run Pipeline" always sets this to true. */
  force?:       boolean;
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
 * Fetch fresh daily bars for a single symbol from Yahoo and
 * upsert them into the `candles` table. Returns `{ written, source }`
 * so the caller can log exactly which upstream served each symbol.
 *
 * Throws only for DB errors — upstream failures resolve to
 * `{ written: 0, source: null }`.
 */
async function ingestOneSymbol(
  symbol: string,
): Promise<{ written: number; source: CandleSource | null; reason?: string }> {
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
 * Refresh daily OHLC bars via Yahoo, scoped to a specific
 * universe. With `force: true` every symbol is re-fetched — the
 * "Run Pipeline" path sets that so stale DB bars never leak into a
 * run. Without `force`, only symbols older than `maxAgeHours` are
 * touched (used by background schedulers).
 */
export async function refreshDailyCandles(
  opts: RefreshCandlesOptions,
): Promise<RefreshCandlesResult> {
  const t0          = Date.now();
  const symbols     = Array.from(
    new Set(opts.symbols.map((s) => s.toUpperCase()).filter(Boolean)),
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
  const toRefresh: LatestRow[] = beforeRows.filter((r) => {
    if (opts.force) return true;
    if (r.latestTs == null) return true;
    return (r.ageHours ?? Infinity) > maxAgeHours;
  });
  result.staleCount = toRefresh.length;

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
  const bySource: Record<string, number> = { yahoo: 0 };
  await mapWithConcurrency(toRefresh, INGEST_CONCURRENCY, async (row) => {
    try {
      const { written, source, reason } = await ingestOneSymbol(row.symbol);
      if (source && written > 0) {
        bySource[source] = (bySource[source] ?? 0) + 1;
        result.refreshed++;
        result.barsIngested += written;
      } else {
        // Upstream returned no usable bars. Not a crash — skip.
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
  });

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
    yahoo: bySource.yahoo ?? 0,
    failed: result.failed.length,
    latestBefore: result.latestTsBefore ?? 'none',
    ageHoursBefore: result.ageHoursBefore ?? null,
    latestAfter: result.latestTsAfter ?? 'none',
    ageHoursAfter: result.ageHoursAfter ?? null,
  });

  return result;
}
