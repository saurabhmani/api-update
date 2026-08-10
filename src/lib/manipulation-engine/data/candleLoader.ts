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

const IST_TZ = 'Asia/Kolkata';

function istToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST_TZ }).format(new Date());
}

/** Calendar day (YYYY-MM-DD) for a candle ts — UTC-midnight date keys stay as stored. */
function barDateKey(ts: string | Date): string {
  if (typeof ts === 'string') {
    const m = ts.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = ts instanceof Date ? ts : new Date(ts);
  if (!Number.isFinite(d.getTime())) return istToday();
  // EOD rows are stored as calendar-day midnights (UTC). Prefer the UTC
  // date key so '2026-08-10 00:00:00' stays 2026-08-10 even under IST sessions.
  return d.toISOString().slice(0, 10);
}

export interface LoadBarsOptions {
  /** Inclusive upper bound (YYYY-MM-DD); defaults to today IST. */
  asOfDate?: string;
  /** How many trailing trading days to load. Default 60. */
  lookback?: number;
}

export async function loadDailyBars(
  symbol: string,
  options: LoadBarsOptions = {},
): Promise<DailyBar[]> {
  const asOf = options.asOfDate ?? istToday();
  const lookback = options.lookback ?? 60;
  const sym = String(symbol ?? '').toUpperCase();

  // Match the trading symbol exactly (NSE_EQ|RELIANCE), not LIKE %REL% which
  // collapses unrelated instruments into one series.
  // DATE(ts) <= asOf: comparing DATETIME to 'YYYY-MM-DD' under +05:30 excludes
  // same-day UTC-midnight bars (treated as after local midnight).
  const { rows } = await db.query<{
    ts: string | Date; open: number; high: number; low: number; close: number; volume: number;
  }>(
    `SELECT ts, open, high, low, close, volume
     FROM candles
     WHERE SUBSTRING_INDEX(instrument_key, '|', -1) = ?
       AND candle_type = 'eod'
       AND interval_unit = '1day'
       AND DATE(ts) <= ?
     ORDER BY ts DESC
     LIMIT ?`,
    [sym, asOf, lookback],
  );

  // Query returned DESC for the LIMIT — flip to ascending for the engine.
  return (rows ?? [])
    .map((r) => ({
      date: barDateKey(r.ts),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume),
    }))
    .reverse();
}
