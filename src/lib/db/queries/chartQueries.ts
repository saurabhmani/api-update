/**
 * Chart Queries
 *
 * All SQL used by chartService.ts, documented with schemas and notes.
 * Every query uses ? placeholders (MySQL/MariaDB). No ?/? syntax.
 *
 * ── Actual candles schema ─────────────────────────────────────────
 *
 * The task spec references candles(symbol, time).
 * The actual Quantorus365 schema is:
 *
 *   candles (
 *     id            INT AUTO_INCREMENT PRIMARY KEY,
 *     instrument_key VARCHAR(150) NOT NULL,   ← maps to "symbol" concept
 *     candle_type    VARCHAR(15)  NOT NULL,    ← 'intraday' | 'eod'
 *     interval_unit  VARCHAR(20)  NOT NULL,    ← '1minute' | '5minute' | '1day'
 *     ts             DATETIME     NOT NULL,    ← maps to "time" column
 *     open           DECIMAL(12,2),
 *     high           DECIMAL(12,2),
 *     low            DECIMAL(12,2),
 *     close          DECIMAL(12,2),
 *     volume         BIGINT,
 *     oi             BIGINT,
 *     UNIQUE KEY uq_candle (instrument_key, candle_type, interval_unit, ts)
 *   )
 *
 * "instrument_key" replaces "symbol" because:
 *   - NSE uses tradingsymbols (e.g. RELIANCE) not CUSIPs/ISINs
 *   - Instrument keys are formatted as (e.g. NSE_EQ|INE002A01018)
 *   - instrument_key is unique across exchanges; symbol alone is not
 *
 * ── Index strategy ────────────────────────────────────────────────
 *
 * Task asks for: CREATE INDEX idx_symbol_time ON candles(symbol, time)
 * Equivalent for our schema (2 indexes):
 */

// ── DDL: Indexes ──────────────────────────────────────────────────

/**
 * Primary lookup index — already created by migrateMarketData.ts.
 * Covers WHERE instrument_key = ? ORDER BY ts DESC queries.
 */
export const IDX_CANDLES_KEY_TS = `
  CREATE INDEX IF NOT EXISTS idx_candles_key_ts
  ON candles (instrument_key, ts DESC)
`;

/**
 * Covering index for chart queries — ADD THIS if not present.
 * Covers WHERE instrument_key = ? AND candle_type = ? AND interval_unit = ?
 * ORDER BY ts DESC LIMIT ?
 * Eliminates the filesort and allows index-only scan.
 *
 * Run once: npx ts-node src/lib/db/queries/chartQueries.ts
 */
export const IDX_CANDLES_COVERING = `
  CREATE INDEX IF NOT EXISTS idx_candles_covering
  ON candles (instrument_key, candle_type, interval_unit, ts DESC)
`;

/**
 * Instrument key resolution index — already on instruments table.
 * Covers: WHERE tradingsymbol = ? AND exchange = 'NSE'
 */
export const IDX_INSTRUMENTS_SYMBOL = `
  CREATE INDEX IF NOT EXISTS idx_instruments_symbol
  ON instruments (tradingsymbol, exchange)
`;

// ── DML: Chart data queries ───────────────────────────────────────

/**
 * Q1 — Resolve instrument_key from plain NSE tradingsymbol.
 * Called once per symbol; result cached in Redis (TTL 1h).
 *
 * params: [symbol]
 */
export const RESOLVE_INSTRUMENT_KEY = `
  SELECT instrument_key
  FROM   instruments
  WHERE  tradingsymbol = ?
    AND  exchange      = 'NSE'
    AND  is_active     = 1
  ORDER BY created_at DESC
  LIMIT 1
`;

/**
 * Q2 — Primary chart query: OHLCV bars for one instrument + interval.
 * Uses idx_candles_covering for index-only scan.
 *
 * ORDER BY ts DESC returns newest first; service reverses to oldest-first.
 *
 * params: [instrument_key, candle_type, interval_unit, limit]
 * example: ('NSE_EQ|INE002A01018', 'intraday', '1minute', 100)
 */
export const CHART_CANDLES = `
  SELECT ts, open, high, low, close, volume, oi
  FROM   candles
  WHERE  instrument_key = ?
    AND  candle_type    = ?
    AND  interval_unit  = ?
  ORDER BY ts DESC
  LIMIT ?
`;

/**
 * Q3 — Chart query with date range filter.
 * Used when ?from= or ?to= params are provided.
 *
 * params: [instrument_key, candle_type, interval_unit, from?, to?, limit]
 * Build dynamically — append AND ts >= ? and/or AND ts <= ? as needed.
 */
export const CHART_CANDLES_RANGE = `
  SELECT ts, open, high, low, close, volume, oi
  FROM   candles
  WHERE  instrument_key = ?
    AND  candle_type    = ?
    AND  interval_unit  = ?
    AND  ts             >= ?
    AND  ts             <= ?
  ORDER BY ts DESC
  LIMIT ?
`;

/**
 * Q4 — Aggregate intraday 1-minute bars into N-minute bars on the fly.
 * Useful when a specific interval (e.g. 3minute) is not stored directly.
 * Uses MySQL FLOOR() on UNIX_TIMESTAMP to bucket timestamps.
 *
 * params: [bucket_seconds, instrument_key, candle_type, limit]
 * example for 5-minute from 1-minute: bucket_seconds = 300
 */
export const CHART_CANDLES_AGGREGATED = `
  SELECT
    FROM_UNIXTIME(
      FLOOR(UNIX_TIMESTAMP(ts) / ?) * ?
    )                             AS ts,
    SUBSTRING_INDEX(GROUP_CONCAT(open  ORDER BY ts ASC), ',', 1)  AS open,
    MAX(high)                     AS high,
    MIN(low)                      AS low,
    SUBSTRING_INDEX(GROUP_CONCAT(close ORDER BY ts DESC), ',', 1) AS close,
    SUM(volume)                   AS volume,
    SUM(oi)                       AS oi
  FROM candles
  WHERE instrument_key = ?
    AND candle_type    = ?
  GROUP BY FLOOR(UNIX_TIMESTAMP(ts) / ?)
  ORDER BY ts DESC
  LIMIT ?
`;
// params: [bucket_sec, bucket_sec, instrument_key, candle_type, bucket_sec, limit]

/**
 * Q5 — Latest single candle (for LTP when Redis is cold).
 * params: [instrument_key]
 */
export const LATEST_CANDLE = `
  SELECT ts, open, high, low, close, volume, oi
  FROM   candles
  WHERE  instrument_key = ?
    AND  candle_type    = 'intraday'
  ORDER BY ts DESC
  LIMIT 1
`;

/**
 * Q6 — Count candles available for a symbol+interval (diagnostic).
 * params: [instrument_key, candle_type, interval_unit]
 */
export const COUNT_CANDLES = `
  SELECT COUNT(*) AS total,
         MIN(ts)  AS earliest,
         MAX(ts)  AS latest
  FROM   candles
  WHERE  instrument_key = ?
    AND  candle_type    = ?
    AND  interval_unit  = ?
`;

// ── Run index migration ───────────────────────────────────────────
// Execute this file directly to add missing covering index:
//   npx ts-node src/lib/db/queries/chartQueries.ts

if (require.main === module) {
  (async () => {
    const { getDb } = await import('@/lib/db');
    const pool = getDb();
    try {
      await pool.execute(IDX_CANDLES_KEY_TS);
      console.log('✓ idx_candles_key_ts');
      await pool.execute(IDX_CANDLES_COVERING);
      console.log('✓ idx_candles_covering');
      await pool.execute(IDX_INSTRUMENTS_SYMBOL);
      console.log('✓ idx_instruments_symbol');
      console.log('\n✅ Chart indexes ready.');
    } catch (e: any) {
      console.error('Index creation failed:', e?.message);
    } finally {
      await pool.end();
    }
  })();
}
