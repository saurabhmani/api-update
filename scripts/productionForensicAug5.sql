-- Production forensic checklist (run on LIVE MySQL only).
-- Compare results to local evidence already collected.

-- 0) Identity
SELECT @@hostname, DATABASE(), NOW(), @@session.time_zone;

-- 1) Last Confirmed = MAX(confirmed_at)
SELECT MAX(confirmed_at) AS last_confirmed_at,
       MAX(updated_at)   AS last_lifecycle_updated_at,
       COUNT(*) AS snapshot_rows,
       SUM(status='ACTIVE') AS active_n,
       SUM(status='EXPIRED') AS expired_n
FROM q365_confirmed_signal_snapshots;

-- 2) Local Aug-5 cohort on production
SELECT symbol, status, confirmed_at, updated_at, classification, confidence_score,
       maturity_score, validation_cycles_passed, source_signal_id
FROM q365_confirmed_signal_snapshots
WHERE symbol IN ('ASAHIINDIA','AVALON','AMBUJACEM')
ORDER BY symbol, confirmed_at;

-- 3) Same symbols: signals since Jul 20
SELECT symbol, created_at, generated_at, generation_source, signal_status,
       classification, confidence_score, final_score, market_regime, code_build
FROM q365_signals
WHERE symbol IN ('ASAHIINDIA','AVALON','AMBUJACEM')
  AND created_at >= '2026-07-20'
ORDER BY symbol, created_at;

-- 4) Candle rows (IST trade date)
SELECT symbol,
       DATE(CONVERT_TZ(ts,'+00:00','+05:30')) AS trade_date_ist,
       open, high, low, close, volume
FROM market_data_daily
WHERE symbol IN ('ASAHIINDIA','AVALON','AMBUJACEM')
  AND DATE(CONVERT_TZ(ts,'+00:00','+05:30')) BETWEEN '2026-08-04' AND '2026-08-07'
ORDER BY symbol, ts;

SELECT source, COUNT(*) c, MAX(ts) mx
FROM candles WHERE candle_type='eod'
GROUP BY source;

SELECT DATE(CONVERT_TZ(ts,'+00:00','+05:30')) d,
       COUNT(DISTINCT instrument_key) symbols
FROM candles WHERE candle_type='eod'
  AND DATE(CONVERT_TZ(ts,'+00:00','+05:30')) IN ('2026-08-05','2026-08-06','2026-08-07')
GROUP BY 1;

-- 5) Maturity trackers for trio
SELECT * FROM q365_signal_maturity_tracker
WHERE symbol IN ('ASAHIINDIA','AVALON','AMBUJACEM');

-- 6) Latest stage timestamps
SELECT MAX(created_at) latest_signal FROM q365_signals;
SELECT MAX(last_evaluated_at) latest_maturity_eval,
       SUM(stage='mature') mature_n,
       COUNT(*) trackers
FROM q365_signal_maturity_tracker;
SELECT MAX(confirmed_at) latest_promotion FROM q365_confirmed_signal_snapshots;

-- 7) Signal sources Aug 5–7
SELECT DATE(created_at) d, generation_source, COUNT(*) c,
       SUM(classification IN ('HIGH_CONVICTION','VALID_SIGNAL')) validish
FROM q365_signals
WHERE created_at >= '2026-08-05' AND created_at < '2026-08-08'
GROUP BY 1,2 ORDER BY 1,3 DESC;
