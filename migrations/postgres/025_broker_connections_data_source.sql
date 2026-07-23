-- Extend broker_connections for data-source login (Postgres sidecar)
-- Migration 025
-- Additive columns + auth transactions. Legacy access_token_enc retained
-- (deprecated — prefer access_token_encrypted when present).

ALTER TABLE broker_connections
  ADD COLUMN IF NOT EXISTS broker_account_id VARCHAR(64),
  ADD COLUMN IF NOT EXISTS broker_user_name VARCHAR(128),
  ADD COLUMN IF NOT EXISTS access_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS refresh_token_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS last_authenticated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_primary BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill encrypted columns from legacy enc columns when empty
UPDATE broker_connections
SET access_token_encrypted = COALESCE(access_token_encrypted, access_token_enc),
    refresh_token_encrypted = COALESCE(refresh_token_encrypted, refresh_token_enc),
    broker_account_id = COALESCE(broker_account_id, broker_user_id),
    last_authenticated_at = COALESCE(last_authenticated_at, updated_at),
    status = CASE WHEN status = 'connected' THEN 'active' ELSE status END
WHERE access_token_enc IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_broker_connections_broker ON broker_connections (broker);
CREATE INDEX IF NOT EXISTS idx_broker_connections_status ON broker_connections (status);
CREATE INDEX IF NOT EXISTS idx_broker_connections_expires ON broker_connections (token_expires_at);

CREATE TABLE IF NOT EXISTS broker_auth_transactions (
  id            VARCHAR(64) PRIMARY KEY,
  user_id       INT NOT NULL,
  broker        VARCHAR(32) NOT NULL,
  state_hash    VARCHAR(128),
  status        VARCHAR(24) NOT NULL DEFAULT 'pending',
  expires_at    TIMESTAMPTZ NOT NULL,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_auth_tx_user ON broker_auth_transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_broker_auth_tx_status ON broker_auth_transactions (status);
CREATE INDEX IF NOT EXISTS idx_broker_auth_tx_expires ON broker_auth_transactions (expires_at);
CREATE INDEX IF NOT EXISTS idx_broker_auth_tx_state ON broker_auth_transactions (state_hash);
