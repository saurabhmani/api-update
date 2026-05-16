// ════════════════════════════════════════════════════════════════
//  snapshotRepo — PostgreSQL persistence for MarketSnapshot
//
//  REFERENCE IMPLEMENTATION for Phase-2 service migrations:
//    • Uses pg (NOT the MySQL shim in src/lib/db.ts)
//    • Native UPSERT via `INSERT ... ON CONFLICT DO UPDATE`
//    • Reads are ≤ 1 statement each, no N+1
//
//  Wired into Phase-1 MarketDataProvider via `registerDbRepo` — once
//  `market.snapshots_current` is populated by the scheduler, the
//  provider's DB fallback will return the last-known value instead
//  of throwing StaleDataError.
// ════════════════════════════════════════════════════════════════

import { pg } from '@/lib/db/postgres';
import type {
  HistoricalCandle,
  HistoricalRange,
  HistoricalSeries,
  MarketSnapshot,
  ProviderSource,
} from '@/types/market';

// Map Phase-1 ProviderResponse.source onto a string the DB accepts.
function toSourceLabel(source: ProviderSource): string {
  return source;
}

// ── Snapshot UPSERT ─────────────────────────────────────────────────

export interface UpsertSnapshotInput extends MarketSnapshot {
  source: ProviderSource;
  dataQuality: string;
}

export async function upsertSnapshot(input: UpsertSnapshotInput): Promise<void> {
  const sql = `
    INSERT INTO market.snapshots_current
      (symbol, price, prev_close, change, change_percent,
       open, high, low, volume, source, data_quality,
       fetched_at, updated_at)
    VALUES
      ($1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11,
       to_timestamp($12 / 1000.0), NOW())
    ON CONFLICT (symbol) DO UPDATE SET
      price          = EXCLUDED.price,
      prev_close     = EXCLUDED.prev_close,
      change         = EXCLUDED.change,
      change_percent = EXCLUDED.change_percent,
      open           = EXCLUDED.open,
      high           = EXCLUDED.high,
      low            = EXCLUDED.low,
      volume         = EXCLUDED.volume,
      source         = EXCLUDED.source,
      data_quality   = EXCLUDED.data_quality,
      fetched_at     = EXCLUDED.fetched_at,
      updated_at     = NOW()
  `;
  await pg.query(sql, [
    input.symbol,
    input.price,
    input.prevClose,
    input.change,
    input.changePercent,
    input.open,
    input.high,
    input.low,
    input.volume,
    toSourceLabel(input.source),
    input.dataQuality,
    input.timestamp,
  ]);
}

/** Batch variant — uses UNNEST for a single round-trip when the
 *  scheduler flushes hundreds of symbols. */
export async function upsertSnapshotBatch(rows: UpsertSnapshotInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  const sql = `
    INSERT INTO market.snapshots_current
      (symbol, price, prev_close, change, change_percent,
       open, high, low, volume, source, data_quality,
       fetched_at, updated_at)
    SELECT
      t.symbol, t.price, t.prev_close, t.change, t.change_percent,
      t.open, t.high, t.low, t.volume, t.source, t.data_quality,
      to_timestamp(t.ts / 1000.0), NOW()
    FROM UNNEST(
      $1::text[],    $2::numeric[], $3::numeric[], $4::numeric[], $5::numeric[],
      $6::numeric[], $7::numeric[], $8::numeric[], $9::bigint[],
      $10::text[],   $11::text[],   $12::bigint[]
    ) AS t(symbol, price, prev_close, change, change_percent,
           open, high, low, volume, source, data_quality, ts)
    ON CONFLICT (symbol) DO UPDATE SET
      price          = EXCLUDED.price,
      prev_close     = EXCLUDED.prev_close,
      change         = EXCLUDED.change,
      change_percent = EXCLUDED.change_percent,
      open           = EXCLUDED.open,
      high           = EXCLUDED.high,
      low            = EXCLUDED.low,
      volume         = EXCLUDED.volume,
      source         = EXCLUDED.source,
      data_quality   = EXCLUDED.data_quality,
      fetched_at     = EXCLUDED.fetched_at,
      updated_at     = NOW()
  `;
  const cols = {
    symbol: rows.map(r => r.symbol),
    price: rows.map(r => r.price),
    prev_close: rows.map(r => r.prevClose),
    change: rows.map(r => r.change),
    change_percent: rows.map(r => r.changePercent),
    open: rows.map(r => r.open),
    high: rows.map(r => r.high),
    low: rows.map(r => r.low),
    volume: rows.map(r => r.volume),
    source: rows.map(r => toSourceLabel(r.source)),
    data_quality: rows.map(r => r.dataQuality),
    ts: rows.map(r => r.timestamp),
  };
  const res = await pg.query(sql, [
    cols.symbol, cols.price, cols.prev_close, cols.change, cols.change_percent,
    cols.open, cols.high, cols.low, cols.volume,
    cols.source, cols.data_quality, cols.ts,
  ]);
  return res.rowCount;
}

// ── Read surface — consumed by MarketDataProvider's DB fallback ─────

interface SnapshotRow {
  symbol: string;
  price: string; prev_close: string; change: string; change_percent: string;
  open: string; high: string; low: string;
  volume: string;
  source: string; data_quality: string;
  fetched_at: Date;
}

function rowToSnapshot(r: SnapshotRow): MarketSnapshot {
  const price = Number(r.price);
  return {
    symbol: r.symbol,
    price,
    ltp: price,
    change: Number(r.change),
    changePercent: Number(r.change_percent),
    volume: Number(r.volume),
    open: Number(r.open),
    high: Number(r.high),
    low: Number(r.low),
    prevClose: Number(r.prev_close),
    timestamp: r.fetched_at.getTime(),
  };
}

export async function getSnapshot(symbol: string): Promise<MarketSnapshot | null> {
  const { rows } = await pg.query<SnapshotRow>(
    `SELECT symbol, price, prev_close, change, change_percent,
            open, high, low, volume, source, data_quality, fetched_at
       FROM market.snapshots_current
      WHERE symbol = $1`,
    [symbol.trim().toUpperCase()],
  );
  if (rows.length === 0) return null;
  return rowToSnapshot(rows[0]);
}

// ── Historical candles (read) ───────────────────────────────────────

interface CandleRow {
  ts: Date; open: string; high: string; low: string; close: string; volume: string;
}

export async function getHistoricalCandles(
  symbol: string,
  range: HistoricalRange,
): Promise<HistoricalSeries | null> {
  const intervalByRange: Record<HistoricalRange, string> = {
    '1d': '5m', '5d': '15m',
    '1mo': '1d', '3mo': '1d', '6mo': '1d', '1y': '1d',
    '5y': '1wk',
  };
  const lookbackByRange: Record<HistoricalRange, string> = {
    '1d': '1 day', '5d': '5 days',
    '1mo': '1 month', '3mo': '3 months', '6mo': '6 months',
    '1y': '1 year', '5y': '5 years',
  };
  const interval = intervalByRange[range];
  const lookback = lookbackByRange[range];
  const { rows } = await pg.query<CandleRow>(
    `SELECT ts, open, high, low, close, volume
       FROM market.candles
      WHERE symbol = $1
        AND interval = $2
        AND ts >= NOW() - $3::interval
      ORDER BY ts ASC`,
    [symbol.trim().toUpperCase(), interval, lookback],
  );
  if (rows.length === 0) return null;
  const candles: HistoricalCandle[] = rows.map(r => ({
    t: r.ts.getTime(),
    o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close),
    v: Number(r.volume),
  }));
  return { symbol: symbol.trim().toUpperCase(), range, candles };
}

// ── Bind into Phase-1 MarketDataProvider ────────────────────────────
//
// Call this ONCE at app boot (instrumentation.ts / server.js). After
// that, the provider's DB fallback tier is live: when IndianAPI +
// cache + Yahoo all fail, `SELECT ... FROM market.snapshots_current` // @deprecated marker
// returns the last known value tagged `source='db' quality='stale'`.
export function registerOnMarketDataProvider(): void {
  // Lazy import to avoid a circular require at module load.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { registerDbRepo } = require('@/providers/MarketDataProvider') as
    typeof import('@/providers/MarketDataProvider');
  registerDbRepo({
    getQuote: getSnapshot, // @deprecated marker
    getHistorical: getHistoricalCandles,
  });
}
