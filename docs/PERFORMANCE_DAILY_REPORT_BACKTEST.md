# Daily Report & Backtesting API — Performance Optimization

**Date:** 2026-07-02  
**Routes:** `GET /api/signals/daily-report`, `GET /api/signals/backtest`

## Bottleneck analysis (pre-optimization)

| Issue | Route | Impact |
|-------|-------|--------|
| **N+1 sequential SQL** — up to 200 `getHistoricalCandles()` calls per request (5 `LIKE` patterns each) | Backtest | **Critical** — often 8–30s+ in production |
| **Nested HTTP** — daily-report called `/api/signals/backtest` which re-fetched `/api/signals` | Daily report | **High** — doubled upstream latency |
| **Sequential I/O** — market movers then signals fetch | Daily report | **Medium** — added wall-clock time |
| **Correlated subquery** on full `candles` table for market movers | Both (movers) | **Medium** — slow on large warehouse |
| **Per-symbol `DATE(ts)` predicates** — prevent index-only scans | Backtest (old) | **Medium** |

## Optimizations implemented

1. **`getHistoricalCandlesBatch()`** — one `IN (...)` query per 100 symbols; uses `SUBSTRING_INDEX(instrument_key,'|',-1)` for symbol match (same semantics as production keys `NSE_EQ|SYMBOL`).
2. **`runSignalsBacktestFromPayload()`** — shared handler; daily-report calls it directly (no nested HTTP).
3. **Parallel `Promise.all`** — daily-report fetches movers + signals concurrently.
4. **Market movers SQL** — `LAG()` window over a ±10 day bounded scan instead of per-row correlated `MAX(ts)` subquery.
5. **`apiPerf.ts`** — structured `[API_PERF]` logs: total ms, per-step ms, SQL count, slow query warnings.

## Recommended indexes (MySQL)

```sql
-- EOD candle lookups (batch backtest + movers)
CREATE INDEX idx_candles_eod_symbol_ts
  ON candles (candle_type, interval_unit, ts);

-- Optional generated column for faster symbol IN (if batch still slow at 1000+ symbols):
-- ALTER TABLE candles ADD COLUMN symbol_key VARCHAR(64)
--   GENERATED ALWAYS AS (UPPER(SUBSTRING_INDEX(instrument_key, '|', -1))) STORED,
-- ADD INDEX idx_candles_eod_sym_ts (candle_type, interval_unit, symbol_key, ts);
```

## Monitoring

Grep production logs:

```bash
pm2 logs quantorus365-prod --lines 500 | grep API_PERF
```

Fields: `totalMs`, `sqlMs`, `sqlQueryCount`, `steps`, `slowSqlCount`.

## Functional guarantees

- API request/response contracts unchanged.
- `runDailyBacktest()` pure logic untouched.
- `buildDailySignalReport()` pure logic untouched.
- Backtest preview shape on daily-report unchanged (`backtestToDailyReportPreview`).
