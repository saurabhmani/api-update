-- ════════════════════════════════════════════════════════════════
--  Migration 008 — fix schema drift / defensive re-assertion
--
--  CONTEXT:
--    001_create_schemas.sql was edited after being applied once
--    (citext extension was missing in the original). The runner
--    warns on checksum drift but won't re-apply an already-tracked
--    migration. This file closes the gap WITHOUT touching 001-007.
--
--  RULES OBEYED:
--    • Every statement is idempotent (IF NOT EXISTS / DO blocks).
--    • No DROP statements — data-loss free on a populated DB.
--    • No column type changes that narrow data.
--    • No reliance on row contents — pure DDL.
--
--  Running this against a fully-migrated DB is a no-op. Running it
--  against a partially-migrated DB (for example: 001 applied, 002
--  failed mid-citext-ext-missing) fills the gaps to a known-good
--  baseline.
-- ════════════════════════════════════════════════════════════════

BEGIN;

-- ── Extensions ──────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

-- ── Schemas ─────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS master;
CREATE SCHEMA IF NOT EXISTS market;
CREATE SCHEMA IF NOT EXISTS intel;
CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS ops;

-- ── auth.users (required by 002 — defensive copy) ───────────────────
CREATE TABLE IF NOT EXISTS auth.users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT      UNIQUE NOT NULL,
  password_hash   TEXT        NOT NULL,
  display_name    TEXT,
  role            TEXT        NOT NULL DEFAULT 'user',
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  mfa_secret      TEXT,
  mfa_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── market.snapshots_current (REQUIRED for UPSERT demos) ────────────
CREATE TABLE IF NOT EXISTS market.snapshots_current (
  symbol          TEXT        PRIMARY KEY,
  price           NUMERIC(18,4) NOT NULL,
  prev_close      NUMERIC(18,4) NOT NULL,
  change          NUMERIC(18,4) NOT NULL,
  change_percent  NUMERIC(10,4) NOT NULL,
  open            NUMERIC(18,4) NOT NULL DEFAULT 0,
  high            NUMERIC(18,4) NOT NULL DEFAULT 0,
  low             NUMERIC(18,4) NOT NULL DEFAULT 0,
  volume          BIGINT        NOT NULL DEFAULT 0,
  source          TEXT          NOT NULL,
  data_quality    TEXT          NOT NULL,
  fetched_at      TIMESTAMPTZ   NOT NULL,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_snapshots_updated ON market.snapshots_current (updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_snapshots_source  ON market.snapshots_current (source);

-- ── market.snapshots_intraday (partitioned parent + default part) ───
CREATE TABLE IF NOT EXISTS market.snapshots_intraday (
  symbol          TEXT          NOT NULL,
  ts              TIMESTAMPTZ   NOT NULL,
  price           NUMERIC(18,4) NOT NULL,
  change_percent  NUMERIC(10,4) NOT NULL,
  volume          BIGINT        NOT NULL DEFAULT 0,
  source          TEXT          NOT NULL,
  PRIMARY KEY (symbol, ts)
) PARTITION BY RANGE (ts);

CREATE TABLE IF NOT EXISTS market.snapshots_intraday_default
  PARTITION OF market.snapshots_intraday DEFAULT;

CREATE INDEX IF NOT EXISTS idx_intraday_symbol_ts
  ON market.snapshots_intraday (symbol, ts DESC);

-- ── market.candles (partitioned parent + default part) ──────────────
CREATE TABLE IF NOT EXISTS market.candles (
  symbol       TEXT          NOT NULL,
  interval     TEXT          NOT NULL,
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

-- ── intel.corporate_events ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS intel.corporate_events (
  id           BIGSERIAL   PRIMARY KEY,
  symbol       TEXT        NOT NULL,
  event_type   TEXT        NOT NULL,
  event_date   DATE        NOT NULL,
  details      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source       TEXT        NOT NULL,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The UNIQUE (symbol, event_type, event_date) may or may not exist
-- depending on how far 005 got. Add idempotently.
DO $$ BEGIN
  ALTER TABLE intel.corporate_events
    ADD CONSTRAINT corporate_events_symbol_type_date_key
    UNIQUE (symbol, event_type, event_date);
EXCEPTION WHEN duplicate_object THEN NULL;
    WHEN duplicate_table  THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_corp_events_symbol_date
  ON intel.corporate_events (symbol, event_date DESC);

-- ── app.watchlists ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS app.watchlists (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL,
  name        TEXT        NOT NULL,
  symbols     TEXT[]      NOT NULL DEFAULT '{}',
  is_default  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE app.watchlists
    ADD CONSTRAINT watchlists_user_name_key UNIQUE (user_id, name);
EXCEPTION WHEN duplicate_object THEN NULL;
    WHEN duplicate_table  THEN NULL;
END $$;

-- The FK to auth.users is only valid once both tables exist. Skip
-- silently if it's already present or if the FK can't be created yet.
DO $$ BEGIN
  ALTER TABLE app.watchlists
    ADD CONSTRAINT watchlists_user_fk
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
    WHEN invalid_foreign_key THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_watchlists_user ON app.watchlists (user_id);

-- ── ops.scheduler_runs ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ops.scheduler_runs (
  id               BIGSERIAL   PRIMARY KEY,
  label            TEXT        NOT NULL,
  started_at       TIMESTAMPTZ NOT NULL,
  finished_at      TIMESTAMPTZ,
  processed_count  INTEGER     NOT NULL DEFAULT 0,
  succeeded_count  INTEGER     NOT NULL DEFAULT 0,
  failed_count     INTEGER     NOT NULL DEFAULT 0,
  stale_count      INTEGER     NOT NULL DEFAULT 0,
  by_source        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  elapsed_ms       INTEGER,
  error_sample     TEXT
);
CREATE INDEX IF NOT EXISTS idx_sched_runs_time ON ops.scheduler_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sched_runs_label ON ops.scheduler_runs (label, started_at DESC);

COMMIT;
