// ════════════════════════════════════════════════════════════════
//  Rolling Window Builder — No-Lookahead Candle Windowing
//
//  Manages a growing window of historical candles for each symbol.
//  On each replay step, returns only candles up to the current date.
//  This is the data backbone for the signal engine during backtest.
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../../signal-engine/types/signalEngine.types';
import type { CandleProvider } from '../../signal-engine/pipeline/generatePhase1Signals';

export interface RollingWindowStore {
  /** Get candles for a symbol up to (and including) the current date */
  getCandlesUpTo(symbol: string, asOfDate: string): Candle[];
  /** Get only the bar for a specific date (null if no trading day) */
  getBar(symbol: string, date: string): Candle | null;
  /** Get the number of bars available for a symbol up to a date */
  getBarCount(symbol: string, asOfDate: string): number;
  /** Create a CandleProvider that respects the date boundary */
  toCandleProvider(asOfDate: string): CandleProvider;
  /** All loaded symbols */
  symbols: string[];
  /** All trading dates in range */
  tradingDates: string[];
}

/**
 * Build a rolling window store from pre-loaded candle data.
 * All data is loaded once, then sliced per-date during replay.
 *
 * @param fullData - Map of symbol → complete candle history (sorted ASC by date)
 * @param startDate - Earliest date in simulation range
 * @param endDate - Latest date in simulation range
 */
export function createRollingWindowStore(
  fullData: Map<string, Candle[]>,
  startDate: string,
  endDate: string,
): RollingWindowStore {
  // Pre-build index: symbol → date → index (for fast lookups)
  const dateIndex = new Map<string, Map<string, number>>();
  for (const [symbol, candles] of Array.from(fullData.entries())) {
    const idx = new Map<string, number>();
    for (let i = 0; i < candles.length; i++) {
      const d = candles[i].ts.split('T')[0];
      idx.set(d, i);
    }
    dateIndex.set(symbol, idx);
  }

  // Collect all unique trading dates in range
  const dateSet = new Set<string>();
  for (const candles of Array.from(fullData.values())) {
    for (const c of candles) {
      const d = c.ts.split('T')[0];
      if (d >= startDate && d <= endDate) dateSet.add(d);
    }
  }
  const tradingDates = Array.from(dateSet).sort();

  return {
    symbols: Array.from(fullData.keys()),
    tradingDates,

    getCandlesUpTo(symbol: string, asOfDate: string): Candle[] {
      const candles = fullData.get(symbol);
      if (!candles || candles.length === 0) return [];

      const cutoff = asOfDate.split('T')[0];
      // Find the last candle on or before cutoff using the index
      const idx = dateIndex.get(symbol);
      if (!idx) return [];

      // Walk backwards from end to find the cutoff
      let end = candles.length;
      for (let i = candles.length - 1; i >= 0; i--) {
        const d = candles[i].ts.split('T')[0];
        if (d <= cutoff) {
          end = i + 1;
          break;
        }
        if (i === 0) end = 0; // all dates are after cutoff
      }

      return candles.slice(0, end);
    },

    getBar(symbol: string, date: string): Candle | null {
      const idx = dateIndex.get(symbol);
      if (!idx) return null;
      const i = idx.get(date.split('T')[0]);
      if (i === undefined) return null;
      return fullData.get(symbol)?.[i] ?? null;
    },

    getBarCount(symbol: string, asOfDate: string): number {
      return this.getCandlesUpTo(symbol, asOfDate).length;
    },

    toCandleProvider(asOfDate: string): CandleProvider {
      const self = this;
      return {
        async fetchDailyCandles(symbol: string): Promise<Candle[]> {
          return self.getCandlesUpTo(symbol, asOfDate);
        },
      };
    },
  };
}
