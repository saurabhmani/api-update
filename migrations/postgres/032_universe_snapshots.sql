-- ════════════════════════════════════════════════════════════════
--  Universe snapshot + rebuild audit (PostgreSQL)
--
--  Weekly NSE 1000 auto-rebuild persists churn decisions here.
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS universe_snapshots (
  id             SERIAL PRIMARY KEY,
  snapshot_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  trigger_source VARCHAR(64) NOT NULL,
  target_size    INT NOT NULL,
  active_count   INT NOT NULL DEFAULT 0,
  added_count    INT NOT NULL DEFAULT 0,
  removed_count  INT NOT NULL DEFAULT 0,
  kept_count     INT NOT NULL DEFAULT 0,
  dry_run        BOOLEAN NOT NULL DEFAULT FALSE,
  ok             BOOLEAN NOT NULL DEFAULT TRUE,
  summary_json   JSONB DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_universe_snapshots_at
  ON universe_snapshots (snapshot_at DESC);

CREATE INDEX IF NOT EXISTS idx_universe_snapshots_trigger
  ON universe_snapshots (trigger_source, snapshot_at DESC);

CREATE TABLE IF NOT EXISTS universe_snapshot_symbols (
  id               BIGSERIAL PRIMARY KEY,
  snapshot_id      INT NOT NULL REFERENCES universe_snapshots(id) ON DELETE CASCADE,
  symbol           VARCHAR(32) NOT NULL,
  rank_position    INT,
  composite_score  NUMERIC(12,6),
  action           VARCHAR(8) NOT NULL CHECK (action IN ('add','keep','remove')),
  data_quality_ok  BOOLEAN NOT NULL DEFAULT FALSE,
  is_active        BOOLEAN NOT NULL DEFAULT FALSE,
  reason           VARCHAR(255),
  UNIQUE (snapshot_id, symbol)
);

CREATE INDEX IF NOT EXISTS idx_snapshot_symbols_action
  ON universe_snapshot_symbols (snapshot_id, action);

CREATE INDEX IF NOT EXISTS idx_snapshot_symbols_symbol
  ON universe_snapshot_symbols (symbol);

CREATE TABLE IF NOT EXISTS universe_rebuild_logs (
  id             SERIAL PRIMARY KEY,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at   TIMESTAMPTZ,
  trigger_source VARCHAR(64) NOT NULL,
  dry_run        BOOLEAN NOT NULL DEFAULT FALSE,
  ok             BOOLEAN NOT NULL DEFAULT FALSE,
  target_size    INT NOT NULL,
  snapshot_id    INT REFERENCES universe_snapshots(id) ON DELETE SET NULL,
  blockers_json  JSONB,
  summary_json   JSONB,
  duration_ms    INT
);

CREATE INDEX IF NOT EXISTS idx_universe_rebuild_started
  ON universe_rebuild_logs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_universe_rebuild_trigger
  ON universe_rebuild_logs (trigger_source, started_at DESC);

COMMIT;
