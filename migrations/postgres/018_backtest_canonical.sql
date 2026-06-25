-- Canonical backtest acceptance schema (logical mapping)
-- Physical tables: strategy_backtests, backtest_summary, backtest_trades (MySQL via migrate.ts)
-- backtest_trades already exists; this documents the Postgres-side mirror if needed.

CREATE TABLE IF NOT EXISTS strategy_backtests (
  id              BIGSERIAL PRIMARY KEY,
  backtest_id     VARCHAR(64)  NOT NULL UNIQUE,
  strategy_id     VARCHAR(64),
  name            VARCHAR(255) NOT NULL,
  status          VARCHAR(32)  NOT NULL DEFAULT 'queued',
  config_json     JSONB        NOT NULL,
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ,
  trade_count     INT          NOT NULL DEFAULT 0,
  signal_count    INT          NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_backtests_strategy ON strategy_backtests (strategy_id);
CREATE INDEX IF NOT EXISTS idx_strategy_backtests_status ON strategy_backtests (status);

CREATE TABLE IF NOT EXISTS backtest_summary (
  id                BIGSERIAL PRIMARY KEY,
  backtest_id       VARCHAR(64) NOT NULL UNIQUE,
  total_return_pct  NUMERIC(10,4),
  win_rate          NUMERIC(8,4),
  sharpe_ratio      NUMERIC(8,4),
  sortino_ratio     NUMERIC(8,4),
  max_drawdown_pct  NUMERIC(8,4),
  profit_factor     NUMERIC(8,4),
  expectancy_r      NUMERIC(8,4),
  total_trades      INT,
  total_signals     INT,
  initial_capital   NUMERIC(14,2),
  final_equity      NUMERIC(14,2),
  summary_json      JSONB,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backtest_summary_backtest ON backtest_summary (backtest_id);

-- backtest_trades: canonical trade history (see migrate.ts for MySQL DDL)
