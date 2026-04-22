-- ════════════════════════════════════════════════════════════════
--  market schema — snapshots, intraday, candles, stats
--
--  Partitioning strategy (documented here, executed below):
--    • snapshots_intraday → daily partitions via pg_partman or
--      manual monthly windows. We create the parent as partitioned;
--      ops layer attaches/detaches partitions.
--    • candles            → monthly partitions by ts.
--
--  MarketDataProvider.registerDbRepo() uses snapshots_current as
--  the "last known" fallback when IndianAPI + Yahoo both fail.
-- ════════════════════════════════════════════════════════════════

BEGIN;

-- ── Current snapshot (one row per symbol) ───────────────────────────
CREATE TABLE IF NOT EXISTS market.snapshots_current (
  symbol          TEXT        PRIMARY KEY REFERENCES master.instruments(symbol) ON DELETE CASCADE,
  price           NUMERIC(18,4) NOT NULL,
  prev_close      NUMERIC(18,4) NOT NULL,
  change          NUMERIC(18,4) NOT NULL,
  change_percent  NUMERIC(10,4) NOT NULL,
  open            NUMERIC(18,4) NOT NULL DEFAULT 0,
  high            NUMERIC(18,4) NOT NULL DEFAULT 0,
  low             NUMERIC(18,4) NOT NULL DEFAULT 0,
  volume          BIGINT        NOT NULL DEFAULT 0,
  source          TEXT          NOT NULL,                -- 'indian' | 'yahoo' | 'db'
  data_quality    TEXT          NOT NULL,                -- 'live' | 'cached-fresh' | ...
  fetched_at      TIMESTAMPTZ   NOT NULL,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_updated ON market.snapshots_current (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_source  ON market.snapshots_current (source);

-- ── Intraday time series (partitioned by day) ───────────────────────
--
-- This is a partitioned parent; actual data lives in child tables
-- like `snapshots_intraday_2026_04_20`. Ops layer attaches new
-- partitions nightly. Declarative partitioning (PG10+) means queries
-- with a ts filter auto-prune to the right partition.
CREATE TABLE IF NOT EXISTS market.snapshots_intraday (
  symbol          TEXT          NOT NULL,
  ts              TIMESTAMPTZ   NOT NULL,
  price           NUMERIC(18,4) NOT NULL,
  change_percent  NUMERIC(10,4) NOT NULL,
  volume          BIGINT        NOT NULL DEFAULT 0,
  source          TEXT          NOT NULL,
  PRIMARY KEY (symbol, ts)
) PARTITION BY RANGE (ts);

-- Default partition keeps inserts from ever failing if an ops job
-- forgets to add the day's partition. Ops should still add daily
-- partitions; the default just prevents PagerDuty at 02:00 IST.
CREATE TABLE IF NOT EXISTS market.snapshots_intraday_default
  PARTITION OF market.snapshots_intraday DEFAULT;

CREATE INDEX IF NOT EXISTS idx_intraday_symbol_ts
  ON market.snapshots_intraday (symbol, ts DESC);

-- ── Historical candles (partitioned monthly) ────────────────────────
CREATE TABLE IF NOT EXISTS market.candles (
  symbol       TEXT          NOT NULL,
  interval     TEXT          NOT NULL,      -- '1m' | '5m' | '15m' | '1h' | '1d' | '1wk'
  ts           TIMESTAMPTZ   NOT NULL,
  open         NUMERIC(18,4) NOT NULL,
  high         NUMERIC(18,4) NOT NULL,
  low          NUMERIC(18,4) NOT NULL,
  close        NUMERIC(18,4) NOT NULL,
  volume       BIGINT        NOT NULL DEFAULT 0,
  source       TEXT          NOT NULL,
  ingested_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, interval, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE IF NOT EXISTS market.candles_default
  PARTITION OF market.candles DEFAULT;

CREATE INDEX IF NOT EXISTS idx_candles_symbol_ts
  ON market.candles (symbol, interval, ts DESC);

-- ── Rolling analytics cache ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market.historical_stats (
  symbol             TEXT        PRIMARY KEY REFERENCES master.instruments(symbol) ON DELETE CASCADE,
  fifty_two_week_high NUMERIC(18,4),
  fifty_two_week_low  NUMERIC(18,4),
  ma_50               NUMERIC(18,4),
  ma_200              NUMERIC(18,4),
  atr_14              NUMERIC(18,4),
  rsi_14              NUMERIC(10,4),
  volatility_30d      NUMERIC(10,4),
  computed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hist_stats_computed ON market.historical_stats (computed_at DESC);

COMMIT;
