// ════════════════════════════════════════════════════════════════
//  Candle Loader — thin adapter from the shared `candles` table to
//  the DailyBar shape the manipulation engine consumes.
//
//  Kept in its own module so the engine stays DB-agnostic: tests can
//  import scanSymbol() directly with synthetic bars, while the API
//  routes use this loader against the real candles table.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { DailyBar } from '../types';

export interface LoadBarsOptions {
  /** Inclusive upper bound; defaults to today. */
  asOfDate?: string;
  /** How many trailing trading days to load. Default 60. */
  lookback?: number;
}

export async function loadDailyBars(
  symbol: string,
  options: LoadBarsOptions = {},
): Promise<DailyBar[]> {
  const asOf = options.asOfDate ?? new Date().toISOString().split('T')[0];
  const lookback = options.lookback ?? 60;

  const { rows } = await db.query<{
    ts: string; open: number; high: number; low: number; close: number; volume: number;
  }>(
    `SELECT ts, open, high, low, close, volume
     FROM candles
     WHERE instrument_key LIKE ?
       AND candle_type = 'eod'
       AND interval_unit = '1day'
       AND ts <= ?
     ORDER BY ts DESC
     LIMIT ?`,
    [`%${symbol}%`, asOf, lookback],
  );

  // Query returned DESC for the LIMIT — flip to ascending for the engine.
  return (rows ?? [])
    .map((r) => ({
      date: typeof r.ts === 'string' ? r.ts.split('T')[0] : new Date(r.ts).toISOString().split('T')[0],
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }))
    .reverse();
}
