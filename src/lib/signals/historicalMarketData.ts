// ════════════════════════════════════════════════════════════════
//  historicalMarketData — PHASE_4_BACKTESTING_2026-05
//
//  Safe adapter for historical OHLC + market-mover + sector data
//  used by the daily backtesting engine.
//
//  CRITICAL SAFETY RULES:
//   - This module NEVER fabricates candles, market movers, or
//     sector strength values.
//   - When the underlying table is missing or empty, the function
//     returns an empty array and adds a warning so callers can mark
//     the report INSUFFICIENT_DATA.
//   - Every read is bounded to the requested [startDate, endDate]
//     range — no future data leaks into a backtest window.
//
//  Data sources used (when available):
//   - MySQL `candles` table (instrument_key / candle_type /
//     interval_unit / ts / open / high / low / close / volume).
//     Used for daily + intraday history.
//   - q365_signals (historical signal pool with rejection codes,
//     factor scores, entry/stop/target geometry).
//
//  Not yet wired (Phase 4B):
//   - Market movers list per date.
//   - Sector strength feed.
//   - Per-signal MFE/MAE tape (would need a per-tick history table).
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'historicalMarketData' });

export type HistoricalInterval = '1minute' | '5minute' | '15minute' | '1hour' | '1day';

export interface HistoricalCandle {
  ts:      string;
  open:    number;
  high:    number;
  low:     number;
  close:   number;
  volume:  number;
}

export interface HistoricalCandleResult {
  symbol:    string;
  interval:  HistoricalInterval;
  candles:   HistoricalCandle[];
  warnings:  string[];
  /** True only when the lookup hit a real row set. False when we
   *  fell back to an empty payload (caller should treat as
   *  INSUFFICIENT_DATA). */
  available: boolean;
}

export interface MarketMover {
  symbol:        string;
  movePercent:   number;
  direction:     'UP' | 'DOWN';
  volume:        number | null;
  date:          string;
}

export interface MarketMoverResult {
  date:      string;
  movers:    MarketMover[];
  warnings:  string[];
  available: boolean;
}

export interface SectorPerformanceItem {
  sector:           string;
  movePercent:      number | null;
  participationPct: number | null;
  notes:            string;
}

export interface SectorPerformanceResult {
  date:       string;
  sectors:    SectorPerformanceItem[];
  warnings:   string[];
  available:  boolean;
}

const intervalToCandleType = (i: HistoricalInterval): { candle_type: string; interval_unit: string } => {
  if (i === '1day')     return { candle_type: 'eod',      interval_unit: '1day' };
  if (i === '1hour')    return { candle_type: 'intraday', interval_unit: '60minute' };
  if (i === '15minute') return { candle_type: 'intraday', interval_unit: '15minute' };
  if (i === '5minute')  return { candle_type: 'intraday', interval_unit: '5minute' };
  return                        { candle_type: 'intraday', interval_unit: '1minute' };
};

/** Pull historical candles for one symbol from the MySQL `candles`
 *  table. Bounded by [startDate, endDate]. Always returns a result —
 *  `available=false + candles=[]` when the lookup found nothing. */
export async function getHistoricalCandles(
  symbol:    string,
  startDate: string,
  endDate:   string,
  interval:  HistoricalInterval = '1day',
): Promise<HistoricalCandleResult> {
  const warnings: string[] = [];
  if (!symbol || !startDate || !endDate) {
    warnings.push('symbol/startDate/endDate required');
    return { symbol, interval, candles: [], warnings, available: false };
  }
  const { candle_type, interval_unit } = intervalToCandleType(interval);

  try {
    const rows: Array<{
      ts: string | Date; open: number; high: number; low: number; close: number; volume: number;
    }> = await (db as any).query(
      `SELECT ts, open, high, low, close, volume
       FROM candles
       WHERE (instrument_key = ?
              OR instrument_key LIKE ?
              OR instrument_key LIKE ?
              OR instrument_key LIKE ?)
         AND candle_type   = ?
         AND interval_unit = ?
         AND ts >= ?
         AND ts <= ?
       ORDER BY ts ASC`,
      [
        symbol, `%|${symbol}`, `${symbol}|%`, `%|${symbol}|%`,
        candle_type, interval_unit,
        startDate, endDate,
      ],
    ).then((r: any) => Array.isArray(r) ? r : (r?.rows ?? []));

    const candles: HistoricalCandle[] = rows.map((r) => ({
      ts:     typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString(),
      open:   Number(r.open),
      high:   Number(r.high),
      low:    Number(r.low),
      close:  Number(r.close),
      volume: Number(r.volume ?? 0),
    }));
    if (candles.length === 0) {
      warnings.push(`No ${interval} candles in DB for ${symbol} between ${startDate} and ${endDate}.`);
    }
    return { symbol, interval, candles, warnings, available: candles.length > 0 };
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown error';
    log.warn('getHistoricalCandles failed', { symbol, interval, msg });
    warnings.push(`Historical candle lookup failed: ${msg}`);
    return { symbol, interval, candles: [], warnings, available: false };
  }
}

/** Pull intraday candles for one symbol on one trade date. */
export async function getIntradayCandles(
  symbol: string,
  date:   string,
  interval: '1minute' | '5minute' | '15minute' | '1hour' = '5minute',
): Promise<HistoricalCandleResult> {
  // Date string YYYY-MM-DD → bracket the whole UTC day. Callers in IST
  // should accept the slightly wider window — the upstream symbol/ts
  // filter still scopes the result to the requested date.
  const start = `${date} 00:00:00`;
  const end   = `${date} 23:59:59`;
  return getHistoricalCandles(symbol, start, end, interval);
}

/** Daily market movers — top symbols by absolute move % on a given
 *  date. Not yet wired (no aggregated mover table). Returns an empty
 *  payload + INSUFFICIENT_DATA marker. */
export async function getMarketMovers(date: string): Promise<MarketMoverResult> {
  // TODO Phase 4B: wire to q365_market_close_snapshot delta vs
  // previous close, or to a dedicated movers table. The current
  // pipeline persists per-symbol snapshots but no aggregated mover
  // ranking. Returning an empty result keeps the backtest engine
  // from fabricating data.
  return {
    date,
    movers:    [],
    warnings:  ['Market movers dataset not configured (Phase 4B). Returning empty list.'],
    available: false,
  };
}

/** Sector performance by date. Not yet wired — sector field is on
 *  q365_universe but no per-day sector aggregator exists. */
export async function getSectorPerformance(date: string): Promise<SectorPerformanceResult> {
  // TODO Phase 4B: aggregate per-sector daily move from q365_universe
  // joined to market close snapshots. For now we return empty so the
  // backtest engine can render INSUFFICIENT_DATA honestly.
  return {
    date,
    sectors:   [],
    warnings:  ['Sector performance feed not configured (Phase 4B). Returning empty list.'],
    available: false,
  };
}

/** Historical signal pool query. Bounded by trade-date range. The
 *  engine reads engineered factor scores + rejection metadata so the
 *  backtest can identify which gate would have admitted each row. */
export interface HistoricalSignalRow {
  id?:                number;
  symbol?:            string | null;
  tradingsymbol?:     string | null;
  direction?:         string | null;
  entry_price?:       number | string | null;
  stop_loss?:         number | string | null;
  target1?:           number | string | null;
  final_score?:       number | null;
  confidence_score?: number | null;
  rr_ratio?:          number | null;
  risk_reward?:       number | null;
  classification?:    string | null;
  signal_status?:     string | null;
  generated_at?:      string | Date | null;
  factor_scores?:     Record<string, unknown> | null;
  rejection_codes?:   string[] | null;
  rejection_reasons?: string[] | null;
  market_regime_score?: number | null;
  conviction_band?:   string | null;
}

export interface HistoricalSignalResult {
  startDate: string;
  endDate:   string;
  rows:      HistoricalSignalRow[];
  warnings:  string[];
  available: boolean;
}

export async function getHistoricalSignals(
  startDate: string,
  endDate:   string,
): Promise<HistoricalSignalResult> {
  const warnings: string[] = [];
  try {
    const rows: any[] = await (db as any).query(
      `SELECT id, symbol, tradingsymbol, direction,
              entry_price, stop_loss, target1,
              final_score, confidence_score, rr_ratio, risk_reward,
              classification, signal_status, generated_at,
              factor_scores, rejection_codes, rejection_reasons,
              market_regime_score, conviction_band
       FROM q365_signals
       WHERE generated_at >= ?
         AND generated_at <= ?
       ORDER BY generated_at ASC
       LIMIT 5000`,
      [`${startDate} 00:00:00`, `${endDate} 23:59:59`],
    ).then((r: any) => Array.isArray(r) ? r : (r?.rows ?? []));

    if (!Array.isArray(rows) || rows.length === 0) {
      warnings.push(`No historical signals found between ${startDate} and ${endDate}.`);
      return { startDate, endDate, rows: [], warnings, available: false };
    }
    return { startDate, endDate, rows, warnings, available: true };
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown error';
    log.warn('getHistoricalSignals failed', { msg });
    warnings.push(`Historical signal lookup failed: ${msg}`);
    return { startDate, endDate, rows: [], warnings, available: false };
  }
}
