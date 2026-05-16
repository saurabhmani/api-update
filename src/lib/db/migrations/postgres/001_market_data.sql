-- ════════════════════════════════════════════════════════════════
--  PostgreSQL schema — market-data core
--
--  This migration is PREP ONLY. It is safe to run against a fresh
--  Postgres database to mirror the contract expected by
--  MarketDataProvider's DB repo. Live cutover from MySQL is a
--  separate project — no code in the app imports this yet.
--
--  Design rules:
--    • `market_snapshots_current` holds ONE row per symbol (latest
--      normalized snapshot) and is what the DB fallback serves.
--    • `historical_candles` is append-only; unique per (symbol, ts).
--    • `corporate_events` captures corporate actions as a time
--      series.
--    • `audit_raw_payloads` stores the unmodified vendor JSON so we
--      can rehydrate after a mapper bug fix without re-fetching.
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS market_snapshots_current (
  symbol           TEXT        PRIMARY KEY,
  price            NUMERIC(18,4)  NOT NULL,
  prev_close       NUMERIC(18,4)  NOT NULL,
  change           NUMERIC(18,4)  NOT NULL,
  change_percent   NUMERIC(10,4)  NOT NULL,
  open             NUMERIC(18,4)  NOT NULL DEFAULT 0,
  high             NUMERIC(18,4)  NOT NULL DEFAULT 0,
  low              NUMERIC(18,4)  NOT NULL DEFAULT 0,
  volume           BIGINT         NOT NULL DEFAULT 0,
  source           TEXT           NOT NULL,
  fetched_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_market_snapshots_updated
  ON market_snapshots_current (updated_at);

CREATE TABLE IF NOT EXISTS historical_candles (
  symbol     TEXT        NOT NULL,
  ts         TIMESTAMPTZ NOT NULL,
  interval   TEXT        NOT NULL,
  open       NUMERIC(18,4) NOT NULL,
  high       NUMERIC(18,4) NOT NULL,
  low        NUMERIC(18,4) NOT NULL,
  close      NUMERIC(18,4) NOT NULL,
  volume     BIGINT        NOT NULL DEFAULT 0,
  source     TEXT          NOT NULL,
  ingested_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (symbol, interval, ts)
);

CREATE INDEX IF NOT EXISTS idx_historical_symbol_ts
  ON historical_candles (symbol, ts DESC);

CREATE TABLE IF NOT EXISTS corporate_events (
  id           BIGSERIAL   PRIMARY KEY,
  symbol       TEXT        NOT NULL,
  event_type   TEXT        NOT NULL,   -- dividend | split | bonus | merger | result
  event_date   DATE        NOT NULL,
  details      JSONB       NOT NULL,
  source       TEXT        NOT NULL,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, event_type, event_date)
);

CREATE INDEX IF NOT EXISTS idx_corp_events_symbol_date
  ON corporate_events (symbol, event_date DESC);

-- Raw vendor payloads — used to replay the mapper against a known
-- input after any adapter change. Partitioning by day is advisable
-- at scale; keep unpartitioned for now to keep the migration simple.
CREATE TABLE IF NOT EXISTS audit_raw_payloads (
  id           BIGSERIAL   PRIMARY KEY,
  provider     TEXT        NOT NULL,   -- 'indian' | 'yahoo'
  endpoint     TEXT        NOT NULL,
  symbol       TEXT,
  payload      JSONB       NOT NULL,
  status_code  INTEGER,
  latency_ms   INTEGER,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_raw_symbol_time
  ON audit_raw_payloads (symbol, fetched_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_raw_provider_time
  ON audit_raw_payloads (provider, fetched_at DESC);

-- Provider health / operational log — scheduler + resilience layer
-- flush records here on each tick so ops dashboards can chart vendor
-- reliability over time.
CREATE TABLE IF NOT EXISTS provider_logs (
  id            BIGSERIAL   PRIMARY KEY,
  provider      TEXT        NOT NULL,
  event         TEXT        NOT NULL,   -- 'success' | 'failure' | 'circuit_open' | 'circuit_closed'
  symbol        TEXT,
  error_message TEXT,
  latency_ms    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_provider_logs_provider_time
  ON provider_logs (provider, created_at DESC);

COMMIT;
