-- Paper Trading acceptance schema — trade_logs, risk_profiles, risk_events
-- Migration 022

CREATE TABLE IF NOT EXISTS trade_logs (
  id              BIGSERIAL PRIMARY KEY,
  account_id      VARCHAR(64) NOT NULL,
  user_id         INT NOT NULL,
  order_id        VARCHAR(64),
  position_id     VARCHAR(64),
  symbol          VARCHAR(32) NOT NULL,
  event_type      VARCHAR(32) NOT NULL,
  side            VARCHAR(8),
  quantity        INT,
  price           NUMERIC(14,4),
  pnl             NUMERIC(18,4),
  fees            NUMERIC(14,4) DEFAULT 0,
  strategy_id     VARCHAR(64),
  details_json    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_logs_account ON trade_logs (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_logs_user ON trade_logs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS risk_profiles (
  id                        VARCHAR(64) PRIMARY KEY,
  user_id                   INT NOT NULL UNIQUE,
  account_id                VARCHAR(64),
  virtual_capital           NUMERIC(18,2) NOT NULL DEFAULT 1000000,
  risk_per_trade_pct        NUMERIC(6,2) NOT NULL DEFAULT 0.5,
  max_daily_loss_pct        NUMERIC(6,2) NOT NULL DEFAULT 2,
  max_open_positions        INT NOT NULL DEFAULT 5,
  max_consecutive_losses    INT NOT NULL DEFAULT 3,
  max_symbol_exposure_pct   NUMERIC(6,2) NOT NULL DEFAULT 15,
  max_strategy_exposure_pct NUMERIC(6,2) NOT NULL DEFAULT 25,
  slippage_bps              NUMERIC(8,2) NOT NULL DEFAULT 10,
  circuit_breaker_drop_pct  NUMERIC(6,2) NOT NULL DEFAULT 5,
  high_volatility_atr_pct   NUMERIC(6,2) NOT NULL DEFAULT 6,
  kill_switch_active        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_profiles_user ON risk_profiles (user_id);

CREATE TABLE IF NOT EXISTS risk_events (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INT NOT NULL,
  account_id      VARCHAR(64),
  event_type      VARCHAR(32) NOT NULL,
  code            VARCHAR(64) NOT NULL,
  message         TEXT NOT NULL,
  symbol          VARCHAR(32),
  strategy_id     VARCHAR(64),
  blocked         BOOLEAN NOT NULL DEFAULT TRUE,
  details_json    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_risk_events_user ON risk_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_events_account ON risk_events (account_id, created_at DESC);
