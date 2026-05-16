-- ════════════════════════════════════════════════════════════════
--  ops schema — scheduler runs, provider health, dead-letter
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS ops.scheduler_runs (
  id               BIGSERIAL   PRIMARY KEY,
  label            TEXT        NOT NULL,      -- 'warmup' | 'intraday' | 'post-close'
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

CREATE TABLE IF NOT EXISTS ops.provider_health_logs (
  id            BIGSERIAL   PRIMARY KEY,
  provider      TEXT        NOT NULL,      -- 'indian' | 'yahoo' | ...
  event         TEXT        NOT NULL,      -- 'success' | 'failure' | 'circuit_open' | 'circuit_closed'
  symbol        TEXT,
  error_message TEXT,
  latency_ms    INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phealth_provider_time ON ops.provider_health_logs (provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_phealth_event_time    ON ops.provider_health_logs (event, created_at DESC);

-- Dead-letter: anything that couldn't be processed inline lands here
-- so a human can inspect the raw payload without scraping logs.
CREATE TABLE IF NOT EXISTS ops.dead_letter_events (
  id           BIGSERIAL   PRIMARY KEY,
  source       TEXT        NOT NULL,       -- 'scheduler' | 'news_ingest' | 'signal_engine' | ...
  payload      JSONB       NOT NULL,
  error_class  TEXT,
  error_message TEXT,
  retry_count  INTEGER     NOT NULL DEFAULT 0,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dlq_unresolved ON ops.dead_letter_events (created_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_dlq_source     ON ops.dead_letter_events (source, created_at DESC);

-- Audit of raw vendor payloads — mirrors the Phase-1 spec so we can
-- replay the mapper after a bug fix without re-hitting the vendor.
CREATE TABLE IF NOT EXISTS ops.audit_raw_payloads (
  id           BIGSERIAL   PRIMARY KEY,
  provider     TEXT        NOT NULL,
  endpoint     TEXT        NOT NULL,
  symbol       TEXT,
  payload      JSONB       NOT NULL,
  status_code  INTEGER,
  latency_ms   INTEGER,
  fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_raw_symbol_time   ON ops.audit_raw_payloads (symbol, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_raw_provider_time ON ops.audit_raw_payloads (provider, fetched_at DESC);

COMMIT;
