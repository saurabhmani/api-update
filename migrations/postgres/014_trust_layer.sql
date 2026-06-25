-- Trust Layer — regime snapshot history for audit trail
-- Migration 014

CREATE TABLE IF NOT EXISTS q365_trust_regime_snapshots (
  id              BIGSERIAL PRIMARY KEY,
  regime_label    VARCHAR(64)  NOT NULL,
  regime_category VARCHAR(32)  NOT NULL,
  benchmark_symbol VARCHAR(32) NOT NULL DEFAULT 'NIFTY 50',
  strength        NUMERIC(6,2),
  confidence      NUMERIC(6,2),
  details_json    JSONB,
  captured_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trust_regime_captured
  ON q365_trust_regime_snapshots (captured_at DESC);
