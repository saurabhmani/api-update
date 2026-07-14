// ════════════════════════════════════════════════════════════════
//  MTF Candle Provider — Product A Phase 4
//
//  Timestamp-safe hourly fetch + 4H aggregation. Never includes
//  candles with open time > asOfMs (no future peek in backtests).
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../types/signalEngine.types';
import { db } from '@/lib/db';

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;

/** Truncate so no candle open is after asOf (timestamp-safe). */
export function truncateCandlesAsOf(candles: Candle[], asOfMs: number): Candle[] {
  return candles.filter((c) => {
    const t = Date.parse(c.ts);
    return Number.isFinite(t) && t <= asOfMs;
  });
}

/** Aggregate consecutive 1H bars into 4H OHLC. */
export function aggregateHourlyToFourHour(hourly: Candle[]): Candle[] {
  if (hourly.length === 0) return [];
  const sorted = [...hourly].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const out: Candle[] = [];
  let bucket: Candle[] = [];
  let bucketStart = 0;

  const flush = () => {
    if (bucket.length === 0) return;
    const first = bucket[0];
    const last = bucket[bucket.length - 1];
    out.push({
      ts: first.ts,
      open: first.open,
      high: Math.max(...bucket.map((c) => c.high)),
      low: Math.min(...bucket.map((c) => c.low)),
      close: last.close,
      volume: bucket.reduce((s, c) => s + (c.volume || 0), 0),
    });
    bucket = [];
  };

  for (const c of sorted) {
    const t = Date.parse(c.ts);
    if (!Number.isFinite(t)) continue;
    if (bucket.length === 0) {
      bucketStart = t;
      bucket.push(c);
      continue;
    }
    if (t - bucketStart >= FOUR_HOURS_MS || bucket.length >= 4) {
      flush();
      bucketStart = t;
      bucket.push(c);
    } else {
      bucket.push(c);
    }
  }
  flush();
  return out;
}

export interface MtfCandleBundle {
  daily: Candle[];
  fourHour: Candle[] | null;
  oneHour: Candle[] | null;
  sources: string[];
  asOfMs: number;
}

/**
 * Load 1H candles from warehouse (timestamp-safe). Returns null arrays when unavailable.
 * Does not fabricate data.
 */
export async function fetchMtfCandleBundle(opts: {
  symbol: string;
  daily: Candle[];
  asOfMs?: number;
  lookbackHours?: number;
}): Promise<MtfCandleBundle> {
  const asOfMs = opts.asOfMs ?? Date.now();
  const daily = truncateCandlesAsOf(opts.daily, asOfMs);
  const sources = ['daily_asof'];
  const lookback = opts.lookbackHours ?? 24 * 40; // ~40 trading days of 1H
  const fromMs = asOfMs - lookback * 60 * 60 * 1000;
  const fromIso = new Date(fromMs).toISOString().slice(0, 19).replace('T', ' ');
  const toIso = new Date(asOfMs).toISOString().slice(0, 19).replace('T', ' ');

  let oneHour: Candle[] | null = null;
  try {
    const { rows } = await db.query(
      `SELECT ts, open, high, low, close, volume
         FROM candles
        WHERE symbol = ?
          AND (
            interval_unit IN ('1hour','60minute','60m')
            OR (candle_type = 'intraday' AND interval_unit IN ('1hour','60minute'))
          )
          AND ts >= ?
          AND ts <= ?
        ORDER BY ts ASC
        LIMIT 800`,
      [opts.symbol.toUpperCase(), fromIso, toIso],
    );
    const parsed = (rows as Array<Record<string, unknown>>).map((r) => ({
      ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
      open: Number(r.open),
      high: Number(r.high),
      low: Number(r.low),
      close: Number(r.close),
      volume: Number(r.volume ?? 0),
    })).filter((c) => Number.isFinite(c.close));

    const truncated = truncateCandlesAsOf(parsed, asOfMs);
    if (truncated.length >= 10) {
      oneHour = truncated;
      sources.push('db_1h');
    }
  } catch {
    // Warehouse may lack intraday — leave null (honest missing)
  }

  let fourHour: Candle[] | null = null;
  if (oneHour && oneHour.length >= 16) {
    fourHour = aggregateHourlyToFourHour(oneHour);
    sources.push('agg_4h_from_1h');
  }

  return { daily, fourHour, oneHour, sources, asOfMs };
}

/** Sync helper for backtests — clip hourly arrays to asOf then aggregate. */
export function buildMtfBundleFromArrays(opts: {
  daily: Candle[];
  hourly: Candle[] | null;
  asOfMs: number;
}): MtfCandleBundle {
  const daily = truncateCandlesAsOf(opts.daily, opts.asOfMs);
  const oneHour = opts.hourly ? truncateCandlesAsOf(opts.hourly, opts.asOfMs) : null;
  const fourHour =
    oneHour && oneHour.length >= 16 ? aggregateHourlyToFourHour(oneHour) : null;
  return {
    daily,
    fourHour,
    oneHour: oneHour && oneHour.length > 0 ? oneHour : null,
    sources: ['replay_arrays'],
    asOfMs: opts.asOfMs,
  };
}
