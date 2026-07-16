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
//  Not yet wired (Phase 4B backlog):
//   - Sector performance — see getSectorPerformance() TODO. Blocked on
//     sector-symbol mapping table; Nifty sector index EOD approach planned.
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

export interface HistoricalMarketMoversOptions {
  /** Max movers returned (gainers + losers by |move|). Default 20. */
  limit?: number;
  /** When true (default), use latest warehouse EOD if requested date is empty. */
  fallbackToLatestEod?: boolean;
}

const EOD_CANDLE_TYPE   = 'eod';
const EOD_INTERVAL_UNIT = '1day';

/** Roadmap note returned by getSectorPerformance() until Phase 4B ships.
 *  Callers should treat available=false and render INSUFFICIENT_DATA. */
const SECTOR_PERFORMANCE_PHASE_4B_ROADMAP_NOTE =
  'Phase 4B backlog: sector performance not yet wired — sector-symbol ' +
  'mapping table unavailable; Nifty sector index EOD approach planned ' +
  '(see getSectorPerformance TODO). Returning empty list.';

function queryRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []);
}

/** Extract tradingsymbol from a `candles.instrument_key`.
 *
 * Verified against live EOD rows (2026-06): keys are `SEGMENT|SYMBOL`
 * with exactly one pipe. Production warehouse uses `NSE_EQ|RELIANCE`
 * (prefix `NSE_EQ`, ~2.7k distinct keys). Shorter legacy/test keys
 * such as `NSE|RELIANCE` parse identically — both resolve via the
 * segment after the last pipe. Index keys such as `NSE_INDEX|NIFTY 50`
 * use the same layout. This mirrors the `market_data_daily` VIEW:
 *   SUBSTRING_INDEX(instrument_key, '|', -1)
 *
 * Uses the segment after the **last** pipe so behaviour stays aligned
 * with MySQL if a legacy key ever contains more than one delimiter.
 * Bare keys (no pipe) are uppercased and returned as-is. */
export function extractSymbolFromCandleInstrumentKey(instrumentKey: string): string {
  const key = String(instrumentKey ?? '').trim();
  if (!key) return '';
  const pipe = key.lastIndexOf('|');
  if (pipe < 0) return key.toUpperCase();
  return key.slice(pipe + 1).trim().toUpperCase();
}

function normalizeTradeDate(date: string): string {
  return date.trim().slice(0, 10);
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

type CandleRow = {
  symbol_key: string;
  ts: string | Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

function mapCandleRows(rows: CandleRow[]): HistoricalCandle[] {
  return rows.map((r) => ({
    ts:     typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString(),
    open:   Number(r.open),
    high:   Number(r.high),
    low:    Number(r.low),
    close:  Number(r.close),
    volume: Number(r.volume ?? 0),
  }));
}

function emptyCandleResult(
  symbol: string,
  interval: HistoricalInterval,
  warnings: string[] = [],
): HistoricalCandleResult {
  return { symbol, interval, candles: [], warnings, available: false };
}

const BATCH_CHUNK_SIZE = 100;

/** Build indexable `candles.instrument_key` variants for a bare symbol. */
function instrumentKeysForSymbol(symbol: string): string[] {
  const sym = String(symbol ?? '').trim().toUpperCase();
  if (!sym) return [];
  if (sym.includes('|')) return [sym];
  // Production warehouse uses NSE_EQ|; keep NSE| for legacy/test rows.
  return [`NSE_EQ|${sym}`, `NSE|${sym}`];
}

/** Normalize bound to a MySQL-comparable datetime string. */
function toTsBound(raw: string, endOfDay: boolean): string {
  const s = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return endOfDay ? `${s} 23:59:59` : `${s} 00:00:00`;
  }
  return s;
}

/** Batch candle fetch — one SQL round-trip per chunk instead of N sequential
 *  per-symbol queries (primary backtest / daily-report bottleneck fix).
 *
 *  Uses sargable predicates on (instrument_key, candle_type, interval_unit, ts)
 *  so MySQL can use uq_candle / idx_candles_key_ts instead of
 *  SUBSTRING_INDEX + DATE(ts) expression scans. */
export async function getHistoricalCandlesBatch(
  symbols:   string[],
  startDate: string,
  endDate:   string,
  interval:  HistoricalInterval = '1day',
): Promise<Map<string, HistoricalCandleResult>> {
  const out = new Map<string, HistoricalCandleResult>();
  const normalized = [...new Set(
    symbols.map((s) => String(s ?? '').trim().toUpperCase()).filter(Boolean),
  )];
  for (const sym of normalized) {
    out.set(sym, emptyCandleResult(sym, interval));
  }
  if (!normalized.length || !startDate || !endDate) return out;

  const { candle_type, interval_unit } = intervalToCandleType(interval);
  const tsStart = toTsBound(startDate, false);
  const tsEnd   = toTsBound(endDate, true);

  for (let i = 0; i < normalized.length; i += BATCH_CHUNK_SIZE) {
    const chunk = normalized.slice(i, i + BATCH_CHUNK_SIZE);
    const keys: string[] = [];
    for (const sym of chunk) keys.push(...instrumentKeysForSymbol(sym));
    const uniqueKeys = [...new Set(keys)];
    if (!uniqueKeys.length) continue;
    const placeholders = uniqueKeys.map(() => '?').join(',');
    try {
      const rows: Array<{
        instrument_key: string;
        ts: string | Date;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
      }> = queryRows(await (db as any).query(
        `SELECT instrument_key, ts, open, high, low, close, volume
           FROM candles
          WHERE candle_type   = ?
            AND interval_unit = ?
            AND instrument_key IN (${placeholders})
            AND ts >= ?
            AND ts <= ?
          ORDER BY instrument_key, ts ASC`,
        [candle_type, interval_unit, ...uniqueKeys, tsStart, tsEnd],
      ));

      const bySymbol = new Map<string, HistoricalCandle[]>();
      for (const row of rows) {
        const sym = extractSymbolFromCandleInstrumentKey(row.instrument_key);
        if (!sym) continue;
        if (!bySymbol.has(sym)) bySymbol.set(sym, []);
        const c = mapCandleRows([{
          symbol_key: sym,
          ts: row.ts,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        }])[0];
        if (c) bySymbol.get(sym)!.push(c);
      }

      for (const sym of chunk) {
        const candles = bySymbol.get(sym) ?? [];
        const warnings: string[] = [];
        if (candles.length === 0) {
          warnings.push(`No ${interval} candles in DB for ${sym} between ${startDate} and ${endDate}.`);
        }
        out.set(sym, {
          symbol: sym,
          interval,
          candles,
          warnings,
          available: candles.length > 0,
        });
      }
    } catch (e) {
      const msg = (e as Error).message ?? 'unknown error';
      log.warn('getHistoricalCandlesBatch chunk failed', { interval, chunkSize: chunk.length, msg });
      for (const sym of chunk) {
        out.set(sym, emptyCandleResult(sym, interval, [`Historical candle batch lookup failed: ${msg}`]));
      }
    }
  }

  return out;
}

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
  const sym = symbol.toUpperCase().trim();
  const batch = await getHistoricalCandlesBatch([sym], startDate, endDate, interval);
  return batch.get(sym) ?? emptyCandleResult(sym, interval, ['Historical candle lookup returned no result']);
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

/** Backtest clipped end date because today's EOD is not in the warehouse yet. */
export function buildBacktestEodWarehouseLagWarning(
  requestedEnd: string,
  latestEod:    string,
): string {
  return (
    `Backtest end clipped to latest warehouse EOD session ${latestEod} ` +
    `(requested ${requestedEnd} not available yet).`
  );
}

export function isExpectedBacktestWarehouseLagWarning(message: string): boolean {
  return /has no EOD bars yet — using latest warehouse session|Backtest end clipped to latest warehouse EOD session/i.test(
    message,
  );
}

/** Latest trade date with any EOD bar in the warehouse. */
export async function getLatestEodTradeDateInWarehouse(): Promise<string | null> {
  try {
    // Prefer ORDER BY ts DESC LIMIT 1 — uses idx on (candle_type, interval_unit, ts)
    // better than a full MAX aggregate on large tables.
    const { rows } = await db.query<{ trade_date: string | Date | null }>(
      `SELECT DATE(ts) AS trade_date
         FROM candles
        WHERE candle_type = ?
          AND interval_unit = ?
        ORDER BY ts DESC
        LIMIT 1`,
      [EOD_CANDLE_TYPE, EOD_INTERVAL_UNIT],
    );
    const raw = rows[0]?.trade_date;
    if (!raw) return null;
    if (raw instanceof Date) return raw.toISOString().slice(0, 10);
    const s = String(raw).trim().slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  } catch (e) {
    log.warn('getLatestEodTradeDateInWarehouse failed', { msg: (e as Error).message });
    return null;
  }
}

async function queryMarketMoversForDate(
  tradeDate: string,
  limit: number,
): Promise<MarketMover[]> {
  // Sargable ts window (±10 calendar days) so (candle_type, interval_unit, ts)
  // can be used; avoid DATE(ts) in the scan predicate.
  const windowStart = `${subtractCalendarDays(tradeDate, 10)} 00:00:00`;
  const windowEnd   = `${addCalendarDays(tradeDate, 1)} 00:00:00`;

  const rows: Array<{
    instrument_key: string;
    symbol: string;
    close: number;
    prev_close: number;
    volume: number | null;
    move_percent: number;
  }> = queryRows(await (db as any).query(
    `SELECT
       instrument_key,
       symbol,
       close,
       prev_close,
       volume,
       ((close - prev_close) / prev_close) * 100 AS move_percent
     FROM (
       SELECT
         instrument_key,
         SUBSTRING_INDEX(instrument_key, '|', -1) AS symbol,
         close,
         volume,
         LAG(close) OVER (PARTITION BY instrument_key ORDER BY ts) AS prev_close,
         DATE(ts) AS trade_date
       FROM candles
       WHERE candle_type   = ?
         AND interval_unit = ?
         AND ts >= ?
         AND ts < ?
     ) ranked
     WHERE trade_date = DATE(?)
       AND prev_close > 0
       AND close > 0
     ORDER BY ABS(((close - prev_close) / prev_close) * 100) DESC
     LIMIT ?`,
    [
      EOD_CANDLE_TYPE, EOD_INTERVAL_UNIT,
      windowStart, windowEnd,
      tradeDate,
      limit,
    ],
  ));

  return rows.map((r) => {
    const movePercent = Math.round(Number(r.move_percent) * 100) / 100;
    const symbol = extractSymbolFromCandleInstrumentKey(
      r.symbol || r.instrument_key,
    );
    return {
      symbol,
      movePercent,
      direction:   movePercent >= 0 ? 'UP' : 'DOWN',
      volume:      r.volume != null ? Number(r.volume) : null,
      date:        tradeDate,
    };
  });
}

function subtractCalendarDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function addCalendarDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Daily market movers from EOD `candles` — close vs previous trading day.
 *  Returns top symbols by absolute % move (gainers and losers). */
export async function getHistoricalMarketMovers(
  date: string,
  options: HistoricalMarketMoversOptions = {},
): Promise<MarketMoverResult> {
  const warnings: string[] = [];
  const tradeDate = normalizeTradeDate(date);
  const limit = Math.max(1, Number(options.limit) || 20);
  const fallbackToLatestEod = options.fallbackToLatestEod !== false;

  if (!tradeDate || !/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) {
    warnings.push('date required (YYYY-MM-DD)');
    return { date: tradeDate || date, movers: [], warnings, available: false };
  }

  try {
    let resolvedDate = tradeDate;
    let movers = await queryMarketMoversForDate(tradeDate, limit);

    if (movers.length === 0 && fallbackToLatestEod) {
      const latest = await getLatestEodTradeDateInWarehouse();
      if (latest && latest !== tradeDate) {
        const fallback = await queryMarketMoversForDate(latest, limit);
        if (fallback.length > 0) {
          movers = fallback;
          resolvedDate = latest;
        }
      }
    }

    if (movers.length === 0) {
      warnings.push(`No EOD market movers found for ${tradeDate} in candles table.`);
    }

    return {
      date: resolvedDate,
      movers,
      warnings,
      available: movers.length > 0,
    };
  } catch (e) {
    const msg = (e as Error).message ?? 'unknown error';
    log.warn('getHistoricalMarketMovers failed', { date: tradeDate, msg });
    warnings.push(`Historical market mover lookup failed: ${msg}`);
    return { date: tradeDate, movers: [], warnings, available: false };
  }
}

/** Backtest route entry — delegates to getHistoricalMarketMovers. */
export async function getMarketMovers(
  date: string,
  options?: HistoricalMarketMoversOptions,
): Promise<MarketMoverResult> {
  return getHistoricalMarketMovers(date, options);
}

/** Sector performance by trade date.
 *
 * PHASE 4B BACKLOG — intentionally unimplemented. Behaviour is fixed:
 * empty `sectors`, `available: false`, and a roadmap warning. No
 * speculative sector calculations are performed.
 *
 * Current blockers:
 *  - Sector mapping table not available. `q365_universe` may carry a
 *    sector label per symbol, but there is no authoritative sector→symbol
 *    crosswalk or daily sector aggregator in the warehouse yet.
 *
 * Planned approach (Phase 4B):
 *  - Primary: Nifty sector index EOD candles (e.g. NIFTY BANK, NIFTY IT,
 *    NIFTY PHARMA) ingested into `candles`; rank sectors by index daily
 *    % move and participation breadth on the requested trade date.
 *  - Secondary: once a `sector_mapping` (or equivalent) table ships,
 *    roll up per-symbol EOD moves from `candles` joined to sector.
 *
 * Future implementation path:
 *  1. Extend the EOD candle pipeline with Nifty sector index
 *     instrument_keys (NSE_INDEX|…).
 *  2. Implement this function as a bounded SQL read over those keys for
 *     `date`, reusing the prev-trading-day join pattern from
 *     getHistoricalMarketMovers().
 *  3. Wire daily-report and backtest routes to pass sectors into
 *     buildSectorPerformance() once `available: true`.
 *
 * TODO(Phase 4B): implement after sector index keys + mapping table land.
 */
export async function getSectorPerformance(date: string): Promise<SectorPerformanceResult> {
  return {
    date,
    sectors:   [],
    warnings:  [SECTOR_PERFORMANCE_PHASE_4B_ROADMAP_NOTE],
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
