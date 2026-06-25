-- Broker acceptance schema — canonical table names
-- Migration 024

CREATE TABLE IF NOT EXISTS broker_accounts (
  id                VARCHAR(64)  PRIMARY KEY,
  user_id           INT          NOT NULL,
  broker            VARCHAR(32)  NOT NULL DEFAULT 'simulated',
  status            VARCHAR(24)  NOT NULL DEFAULT 'disconnected',
  broker_user_id    VARCHAR(64),
  metadata_json     JSONB,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, broker)
);

CREATE INDEX IF NOT EXISTS idx_broker_accounts_user ON broker_accounts (user_id);

CREATE TABLE IF NOT EXISTS broker_tokens (
  id                VARCHAR(64)  PRIMARY KEY,
  account_id        VARCHAR(64)  NOT NULL REFERENCES broker_accounts(id) ON DELETE CASCADE,
  user_id           INT          NOT NULL,
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  token_expires_at  TIMESTAMPTZ,
  last_refresh_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (account_id)
);

CREATE INDEX IF NOT EXISTS idx_broker_tokens_user ON broker_tokens (user_id);

CREATE TABLE IF NOT EXISTS live_orders (
  id                VARCHAR(64)  PRIMARY KEY,
  user_id           INT          NOT NULL,
  broker            VARCHAR(32)  NOT NULL,
  broker_order_id   VARCHAR(64),
  symbol            VARCHAR(32)  NOT NULL,
  side              VARCHAR(8)   NOT NULL,
  order_type        VARCHAR(16)  NOT NULL,
  quantity          INT          NOT NULL,
  filled_qty        INT          NOT NULL DEFAULT 0,
  price             NUMERIC(14,4),
  avg_fill_price    NUMERIC(14,4),
  status            VARCHAR(24)  NOT NULL DEFAULT 'PENDING',
  strategy_id       VARCHAR(64),
  position_id       VARCHAR(64),
  sync_status       VARCHAR(24)  NOT NULL DEFAULT 'pending',
  last_synced_at    TIMESTAMPTZ,
  raw_json          JSONB,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_orders_user ON live_orders (user_id, status);

CREATE TABLE IF NOT EXISTS live_positions (
  id                VARCHAR(64)  PRIMARY KEY,
  user_id           INT          NOT NULL,
  broker            VARCHAR(32)  NOT NULL,
  symbol            VARCHAR(32)  NOT NULL,
  side              VARCHAR(8)   NOT NULL,
  quantity          INT          NOT NULL,
  avg_price         NUMERIC(14,4) NOT NULL,
  current_price     NUMERIC(14,4),
  unrealized_pnl    NUMERIC(18,4) DEFAULT 0,
  status            VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
  strategy_id       VARCHAR(64),
  sync_status       VARCHAR(24)  NOT NULL DEFAULT 'pending',
  last_synced_at    TIMESTAMPTZ,
  opened_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  closed_at         TIMESTAMPTZ,
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_live_positions_user ON live_positions (user_id, status);

CREATE TABLE IF NOT EXISTS broker_error_logs (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INT,
  broker            VARCHAR(32),
  operation         VARCHAR(64) NOT NULL,
  error_code        VARCHAR(64),
  error_message     TEXT NOT NULL,
  retry_count       INT NOT NULL DEFAULT 0,
  request_json      JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broker_error_logs_user ON broker_error_logs (user_id, created_at DESC);
