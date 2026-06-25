-- Broker Integration Layer — connections, sync, health, live gates
-- Migration 023

CREATE TABLE IF NOT EXISTS broker_connections (
  id                VARCHAR(64)  PRIMARY KEY,
  user_id           INT          NOT NULL,
  broker            VARCHAR(32)  NOT NULL DEFAULT 'simulated',
  status            VARCHAR(24)  NOT NULL DEFAULT 'disconnected',
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  token_expires_at  TIMESTAMPTZ,
  broker_user_id    VARCHAR(64),
  metadata_json     JSONB,
  last_refresh_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, broker)
);

CREATE INDEX IF NOT EXISTS idx_broker_connections_user ON broker_connections (user_id);

CREATE TABLE IF NOT EXISTS broker_orders (
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

CREATE INDEX IF NOT EXISTS idx_broker_orders_user ON broker_orders (user_id, status);
CREATE INDEX IF NOT EXISTS idx_broker_orders_broker_id ON broker_orders (broker_order_id);

CREATE TABLE IF NOT EXISTS broker_positions (
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

CREATE INDEX IF NOT EXISTS idx_broker_positions_user ON broker_positions (user_id, status);

CREATE TABLE IF NOT EXISTS broker_sync_log (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INT NOT NULL,
  sync_type         VARCHAR(24) NOT NULL,
  broker            VARCHAR(32) NOT NULL,
  records_synced    INT NOT NULL DEFAULT 0,
  status            VARCHAR(16) NOT NULL,
  error_message     TEXT,
  duration_ms       INT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS broker_failures (
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

CREATE INDEX IF NOT EXISTS idx_broker_failures_user ON broker_failures (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS broker_health_snapshots (
  id                BIGSERIAL PRIMARY KEY,
  broker            VARCHAR(32) NOT NULL,
  status            VARCHAR(16) NOT NULL,
  latency_ms        INT,
  token_valid       BOOLEAN,
  last_order_at     TIMESTAMPTZ,
  error_rate_pct    NUMERIC(6,2),
  details_json      JSONB,
  checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_trading_disclaimers (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INT NOT NULL UNIQUE,
  version           VARCHAR(16) NOT NULL DEFAULT '1.0',
  accepted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address        VARCHAR(64),
  user_agent        TEXT
);

CREATE TABLE IF NOT EXISTS broker_kill_switch_log (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INT,
  action            VARCHAR(32) NOT NULL,
  reason            TEXT,
  actor             VARCHAR(100),
  scope             VARCHAR(16) NOT NULL DEFAULT 'user',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
