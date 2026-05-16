/**
 * Stock Detail Queries
 *
 * All MySQL queries used by stockDetailService.ts, documented in one place.
 * Every query uses ? placeholders — never ?/?.
 *
 * Tables:
 *   instruments   — resolves tradingsymbol → instrument_key
 *   candles       — OHLCV bars keyed by instrument_key
 *   rankings      — Quantorus365 score per symbol
 *   signals       — signal_type + strength per instrument
 *   signal_reasons — per-reason rows linked to signals.id
 */

// ── Q1: Resolve instrument_key from NSE tradingsymbol ─────────────
// Used once per symbol; result cached in Redis (key: ikey:{SYMBOL}, TTL 1h).
// Always filter exchange='NSE' and is_active=1 to avoid F&O duplicates.
export const RESOLVE_INSTRUMENT_KEY = `
  SELECT instrument_key, name
  FROM instruments
  WHERE tradingsymbol = ?
    AND exchange      = 'NSE'
    AND is_active     = 1
  ORDER BY created_at DESC
  LIMIT 1
`;
// params: [symbol]

// ── Q2: Latest intraday candle (LTP proxy when Redis is cold) ─────
export const LATEST_INTRADAY_CANDLE = `
  SELECT open, high, low, close, volume, oi, ts
  FROM candles
  WHERE instrument_key = ?
    AND candle_type    = 'intraday'
  ORDER BY ts DESC
  LIMIT 1
`;
// params: [instrument_key]

// ── Q3: 52-Week high / low from EOD candles ───────────────────────
// Used when NSE quote cache (nse:/quote-equity?symbol=...) is missing
// weekHighLow data. Uses MAX/MIN over the past 365 days of EOD bars.
export const WEEK52_HIGH_LOW = `
  SELECT MAX(high) AS week52_high,
         MIN(low)  AS week52_low
  FROM candles
  WHERE instrument_key = ?
    AND candle_type    = 'eod'
    AND ts             >= DATE_SUB(NOW(), INTERVAL 365 DAY)
`;
// params: [instrument_key]

// ── Q4: Candle history (the primary candle query) ─────────────────
// Returns up to LIMIT candles for a given instrument + interval.
// Note: ORDER BY ts DESC so newest rows are returned first,
//       then reversed to oldest-first in the service layer.
export const CANDLE_HISTORY = `
  SELECT ts, open, high, low, close, volume, oi
  FROM candles
  WHERE instrument_key = ?
    AND candle_type    = ?
    AND interval_unit  = ?
  ORDER BY ts DESC
  LIMIT ?
`;
// params: [instrument_key, candle_type ('intraday'|'eod'), interval_unit, limit]
// Example: ('NSE_EQ|INE002A01018', 'intraday', '1minute', 100)

// ── Q5: Quantorus365 ranking score ────────────────────────────────────
// rankings.score = 0–100 derived from pct_change by dataSync.ts.
// One score row per symbol; take the highest if duplicates exist.
export const RANKING_SCORE = `
  SELECT score, rank_position
  FROM rankings
  WHERE tradingsymbol = ?
  ORDER BY score DESC
  LIMIT 1
`;
// params: [symbol]

// ── Q6: Most recent signal for an instrument ──────────────────────
// Joins on instrument_key OR tradingsymbol to handle both cases
// (sometimes signals are written without instrument_key populated).
export const LATEST_SIGNAL = `
  SELECT id, signal_type, strength, description, generated_at
  FROM signals
  WHERE instrument_key = ?
     OR tradingsymbol  = ?
  ORDER BY generated_at DESC
  LIMIT 1
`;
// params: [instrument_key, symbol]

// ── Q7: Signal reasons for a given signal_id ─────────────────────
// signal_reasons rows are linked to signals.id via FK.
// rank orders the reasons by importance (1 = most important).
export const SIGNAL_REASONS = `
  SELECT rank, reason_text, factor_key
  FROM signal_reasons
  WHERE signal_id = ?
  ORDER BY rank ASC
`;
// params: [signal_id]

// ── Q8: Combined — signal + reasons in one round trip (optional) ──
// Use this instead of Q6+Q7 when you want to avoid two DB calls.
// json_agg is MySQL 8+ (MariaDB 10.5+). Falls back to Q6+Q7 if unsupported.
export const SIGNAL_WITH_REASONS_COMBINED = `
  SELECT
    s.id,
    s.signal_type,
    s.strength,
    s.description,
    s.generated_at,
    sr.rank,
    sr.reason_text,
    sr.factor_key
  FROM signals s
  LEFT JOIN signal_reasons sr ON sr.signal_id = s.id
  WHERE (s.instrument_key = ? OR s.tradingsymbol = ?)
    AND s.generated_at = (
      SELECT MAX(generated_at)
      FROM signals
      WHERE instrument_key = ?
         OR tradingsymbol  = ?
    )
  ORDER BY sr.rank ASC
`;
// params: [instrument_key, symbol, instrument_key, symbol]
// Note: Returns multiple rows (one per reason); group in service layer.
