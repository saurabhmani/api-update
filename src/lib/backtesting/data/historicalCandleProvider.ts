// ════════════════════════════════════════════════════════════════
//  Historical Candle Provider — Zero Lookahead Bias
//
//  Implements the CandleProvider interface from the signal engine
//  but serves only candles up to a specific "as-of" date. This is
//  the critical anti-lookahead layer: the signal engine sees
//  EXACTLY what it would have seen on that historical date.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { Candle } from '../../signal-engine/types/signalEngine.types';
import type { CandleProvider } from '../../signal-engine/pipeline/generatePhase1Signals';
import { runWithConcurrency } from '../utils/concurrencyPool';
import { logger as baseLogger } from '../utils/logger';

/** Default parallelism for per-symbol candle preload. */
export const DEFAULT_PRELOAD_CONCURRENCY = 8;

/**
 * Creates a CandleProvider that returns candles up to (and including) the given date.
 * This ensures no future data leaks into the signal engine during backtesting.
 *
 * @param asOfDate - The simulation date (inclusive). No candles after this date will be returned.
 * @param minBars - Minimum number of candles to return (for warmup/indicator calculation).
 */
export function createHistoricalCandleProvider(
  asOfDate: string,
  minBars: number = 220,
): CandleProvider {
  // Pre-loaded cache to avoid repeated DB hits within the same simulation day
  const cache = new Map<string, Candle[]>();

  return {
    async fetchDailyCandles(symbol: string): Promise<Candle[]> {
      // Check cache first
      const cacheKey = `${symbol}:${asOfDate}`;
      if (cache.has(cacheKey)) {
        return cache.get(cacheKey)!;
      }

      // Fetch from database: only candles on or before asOfDate
      const result = await db.query<{
        ts: string; open: number; high: number; low: number; close: number; volume: number;
      }>(
        `SELECT ts, open, high, low, close, volume
         FROM candles
         WHERE (instrument_key = ?
                OR instrument_key LIKE ?
                OR instrument_key LIKE ?
                OR instrument_key LIKE ?)
           AND candle_type = 'eod'
           AND interval_unit = '1day'
           AND ts <= ?
         ORDER BY ts ASC
         LIMIT ?`,
        [symbol, `%|${symbol}`, `${symbol}|%`, `%|${symbol}|%`, asOfDate, minBars + 50],
      );

      const candles: Candle[] = (result.rows ?? []).map((r) => ({
        ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString().split('T')[0],
        open: Number(r.open),
        high: Number(r.high),
        low: Number(r.low),
        close: Number(r.close),
        volume: Number(r.volume),
      }));

      cache.set(cacheKey, candles);
      return candles;
    },
  };
}

/**
 * Pre-load all candles for a date range into memory for fast replay.
 * Returns a function that creates providers for any date within the range.
 *
 * This is the high-performance path for full backtests: loads data once,
 * then slices it per-day without hitting the database again.
 */
export interface PreloadedDataStore {
  getProviderForDate: (asOfDate: string) => CandleProvider;
  tradingDates: string[];
  symbolsLoaded: number;
  candlesLoaded: number;
  /** Raw per-symbol candles — exposed so the validator/orchestrator can inspect it. */
  rawData: Map<string, Candle[]>;
  /** Per-symbol fetch time in ms (Section 1 perf metrics). */
  symbolLoadMs?: Map<string, number>;
  /** Total wall-clock time for the preload phase in ms. */
  preloadMs?: number;
}

export async function preloadCandleData(
  symbols: string[],
  startDate: string,
  endDate: string,
  concurrency: number = DEFAULT_PRELOAD_CONCURRENCY,
): Promise<PreloadedDataStore> {
  // Load ALL candles for all symbols in date range (with warmup buffer).
  // Section 1: symbols are fetched in parallel with bounded concurrency so
  // a 500-symbol universe doesn't serialize on round-trip latency.
  const fullData = new Map<string, Candle[]>();
  const symbolLoadMs = new Map<string, number>();
  let totalCandles = 0;
  const log = baseLogger.child({ step: 'preload_candles' });
  const preloadStart = Date.now();

  const fetchOne = async (symbol: string): Promise<{ symbol: string; candles: Candle[]; ms: number }> => {
    const t0 = Date.now();
    // Match common instrument_key formats: 'NSE_EQ|RELIANCE', 'NSE_INDEX|NIFTY 50',
    // or a bare symbol. The trailing '|' anchor prevents 'RELIANCE' matching
    // 'RELIANCEPP' / similar look-alikes.
    const result = await db.query<{
      ts: string; open: number; high: number; low: number; close: number; volume: number;
    }>(
      `SELECT ts, open, high, low, close, volume
       FROM candles
       WHERE (instrument_key = ?
              OR instrument_key LIKE ?
              OR instrument_key LIKE ?
              OR instrument_key LIKE ?)
         AND candle_type = 'eod'
         AND interval_unit = '1day'
         AND ts <= ?
       ORDER BY ts ASC`,
      [
        symbol,
        `%|${symbol}`,
        `${symbol}|%`,
        `%|${symbol}|%`,
        endDate,
      ],
    );

    const candles: Candle[] = (result.rows ?? []).map((r) => ({
      ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString().split('T')[0],
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }));

    const ms = Date.now() - t0;
    log.debug('symbol_loaded', { symbol, candles: candles.length, ms });
    return { symbol, candles, ms };
  };

  const loaded = await runWithConcurrency(
    symbols.map((s) => () => fetchOne(s)),
    { maxConcurrency: Math.max(1, concurrency) },
  );

  let symbolsWithData = 0;
  let symbolsEmpty = 0;
  const emptySymbols: string[] = [];
  for (const { symbol, candles, ms } of loaded) {
    fullData.set(symbol, candles);
    symbolLoadMs.set(symbol, ms);
    totalCandles += candles.length;
    if (candles.length === 0) {
      symbolsEmpty++;
      if (emptySymbols.length < 10) emptySymbols.push(symbol);
    } else {
      symbolsWithData++;
    }
  }
  const preloadMs = Date.now() - preloadStart;

  log.info('preload_complete', {
    symbols: symbols.length,
    candles: totalCandles,
    symbolsWithData,
    symbolsEmpty,
    avgCandlesPerSymbol: symbols.length > 0 ? Math.round(totalCandles / symbols.length) : 0,
    concurrency,
    ms: preloadMs,
  });
  if (symbolsEmpty > 0) {
    console.warn(`[preloadCandleData] ${symbolsEmpty}/${symbols.length} symbols returned ZERO candles. First empty: ${emptySymbols.join(', ')}`);
  }
  if (symbolsWithData > 0 && totalCandles / symbolsWithData < 50) {
    console.warn(`[preloadCandleData] avg candles per symbol = ${Math.round(totalCandles / symbolsWithData)} — far below typical warmup (100+). Backtests will fail to generate signals.`);
  }

  // Extract unique trading dates within the simulation range
  const dateSet = new Set<string>();
  for (const candles of Array.from(fullData.values())) {
    for (const c of candles) {
      const d = c.ts.split('T')[0];
      if (d >= startDate && d <= endDate) {
        dateSet.add(d);
      }
    }
  }
  const tradingDates = Array.from(dateSet).sort();

  // Provider factory: slices candles up to the given date
  function getProviderForDate(asOfDate: string): CandleProvider {
    return {
      async fetchDailyCandles(symbol: string): Promise<Candle[]> {
        const allCandles = fullData.get(symbol) ?? [];
        // Binary search for the cutoff point (inclusive)
        const cutoffDate = asOfDate.split('T')[0];
        let end = allCandles.length;
        for (let i = allCandles.length - 1; i >= 0; i--) {
          if (allCandles[i].ts.split('T')[0] <= cutoffDate) {
            end = i + 1;
            break;
          }
        }
        return allCandles.slice(0, end);
      },
    };
  }

  return {
    getProviderForDate,
    tradingDates,
    symbolsLoaded: fullData.size,
    candlesLoaded: totalCandles,
    rawData: fullData,
    symbolLoadMs,
    preloadMs,
  };
}

/**
 * Build a data store from a pre-cleaned map of candles.
 * Used after the validator has rejected/repaired the raw data.
 */
export function buildDataStoreFromMap(
  cleaned: Map<string, Candle[]>,
  startDate: string,
  endDate: string,
  prior?: { symbolLoadMs?: Map<string, number>; preloadMs?: number },
): PreloadedDataStore {
  let totalCandles = 0;
  const dateSet = new Set<string>();

  for (const candles of Array.from(cleaned.values())) {
    totalCandles += candles.length;
    for (const c of candles) {
      const d = c.ts.split('T')[0];
      if (d >= startDate && d <= endDate) dateSet.add(d);
    }
  }
  const tradingDates = Array.from(dateSet).sort();

  function getProviderForDate(asOfDate: string): CandleProvider {
    return {
      async fetchDailyCandles(symbol: string): Promise<Candle[]> {
        const allCandles = cleaned.get(symbol) ?? [];
        const cutoffDate = asOfDate.split('T')[0];
        let end = allCandles.length;
        for (let i = allCandles.length - 1; i >= 0; i--) {
          if (allCandles[i].ts.split('T')[0] <= cutoffDate) {
            end = i + 1;
            break;
          }
        }
        return allCandles.slice(0, end);
      },
    };
  }

  return {
    getProviderForDate,
    tradingDates,
    symbolsLoaded: cleaned.size,
    candlesLoaded: totalCandles,
    rawData: cleaned,
    symbolLoadMs: prior?.symbolLoadMs,
    preloadMs: prior?.preloadMs,
  };
}

/**
 * Get candles AFTER a signal date for outcome evaluation.
 * Used to replay what happened after a signal was generated.
 */
export async function getPostSignalCandles(
  symbol: string,
  signalDate: string,
  barsForward: number,
): Promise<Candle[]> {
  const result = await db.query<{
    ts: string; open: number; high: number; low: number; close: number; volume: number;
  }>(
    `SELECT ts, open, high, low, close, volume
     FROM candles
     WHERE instrument_key LIKE ?
       AND candle_type = 'eod'
       AND interval_unit = '1day'
       AND ts > ?
     ORDER BY ts ASC
     LIMIT ?`,
    [`%${symbol}%`, signalDate, barsForward],
  );

  return (result.rows ?? []).map((r) => ({
    ts: typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString().split('T')[0],
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    close: Number(r.close),
    volume: Number(r.volume),
  }));
}
