-- Paper Trading Engine — virtual brokerage schema
-- Migration 021

CREATE TABLE IF NOT EXISTS paper_accounts (
  id                  VARCHAR(64)  PRIMARY KEY,
  user_id             INT          NOT NULL,
  name                VARCHAR(128) NOT NULL DEFAULT 'Paper Account',
  virtual_capital     NUMERIC(18,2) NOT NULL DEFAULT 1000000,
  cash_balance        NUMERIC(18,2) NOT NULL,
  equity              NUMERIC(18,2) NOT NULL,
  realized_pnl        NUMERIC(18,2) NOT NULL DEFAULT 0,
  unrealized_pnl      NUMERIC(18,2) NOT NULL DEFAULT 0,
  max_daily_loss_pct  NUMERIC(6,2)  NOT NULL DEFAULT 2,
  max_open_positions  INT          NOT NULL DEFAULT 5,
  risk_per_trade_pct  NUMERIC(6,2)  NOT NULL DEFAULT 0.5,
  max_consecutive_losses INT       NOT NULL DEFAULT 3,
  consecutive_losses  INT          NOT NULL DEFAULT 0,
  daily_pnl           NUMERIC(18,2) NOT NULL DEFAULT 0,
  daily_pnl_reset_at  DATE,
  kill_switch_active  BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paper_accounts_user ON paper_accounts (user_id);

CREATE TABLE IF NOT EXISTS paper_orders (
  id                  VARCHAR(64)  PRIMARY KEY,
  account_id          VARCHAR(64)  NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
  symbol              VARCHAR(32)  NOT NULL,
  side                VARCHAR(8)   NOT NULL,
  order_type          VARCHAR(16)  NOT NULL DEFAULT 'MARKET',
  role                VARCHAR(16)  NOT NULL DEFAULT 'ENTRY',
  quantity            INT          NOT NULL,
  limit_price         NUMERIC(14,4),
  stop_price          NUMERIC(14,4),
  trigger_price       NUMERIC(14,4),
  status              VARCHAR(24)  NOT NULL DEFAULT 'PENDING',
  strategy_id         VARCHAR(64),
  parent_order_id     VARCHAR(64),
  position_id         VARCHAR(64),
  filled_qty          INT          NOT NULL DEFAULT 0,
  avg_fill_price      NUMERIC(14,4),
  reject_reason       TEXT,
  idempotency_key     VARCHAR(128),
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_paper_orders_account_status ON paper_orders (account_id, status);
CREATE INDEX IF NOT EXISTS idx_paper_orders_symbol ON paper_orders (symbol, status);

CREATE TABLE IF NOT EXISTS paper_positions (
  id                  VARCHAR(64)  PRIMARY KEY,
  account_id          VARCHAR(64)  NOT NULL REFERENCES paper_accounts(id) ON DELETE CASCADE,
  symbol              VARCHAR(32)  NOT NULL,
  side                VARCHAR(8)   NOT NULL,
  quantity            INT          NOT NULL,
  entry_price         NUMERIC(14,4) NOT NULL,
  current_price       NUMERIC(14,4),
  stop_loss           NUMERIC(14,4),
  take_profit         NUMERIC(14,4),
  unrealized_pnl      NUMERIC(18,4) NOT NULL DEFAULT 0,
  realized_pnl        NUMERIC(18,4),
  status              VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
  strategy_id         VARCHAR(64),
  entry_order_id      VARCHAR(64),
  exit_order_id       VARCHAR(64),
  exit_reason         VARCHAR(32),
  opened_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  closed_at           TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paper_positions_account ON paper_positions (account_id, status);

CREATE TABLE IF NOT EXISTS paper_fills (
  id                  BIGSERIAL PRIMARY KEY,
  account_id          VARCHAR(64) NOT NULL,
  order_id            VARCHAR(64) NOT NULL,
  position_id         VARCHAR(64),
  symbol              VARCHAR(32) NOT NULL,
  side                VARCHAR(8)  NOT NULL,
  quantity            INT         NOT NULL,
  fill_price          NUMERIC(14,4) NOT NULL,
  slippage_bps        NUMERIC(8,2) NOT NULL DEFAULT 0,
  fees                NUMERIC(14,4) NOT NULL DEFAULT 0,
  filled_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paper_fills_account ON paper_fills (account_id, filled_at DESC);

CREATE TABLE IF NOT EXISTS paper_kill_switch_log (
  id                  BIGSERIAL PRIMARY KEY,
  account_id          VARCHAR(64),
  user_id             INT,
  action              VARCHAR(32) NOT NULL,
  reason              TEXT,
  actor               VARCHAR(100),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_paper_kill_switch_account ON paper_kill_switch_log (account_id, created_at DESC);
