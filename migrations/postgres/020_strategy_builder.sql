-- Strategy Builder acceptance schema
-- Migration 020

CREATE TABLE IF NOT EXISTS user_strategies (
  id                  VARCHAR(64)  PRIMARY KEY,
  user_id             VARCHAR(100),
  name                VARCHAR(255) NOT NULL,
  description         TEXT,
  source              VARCHAR(32)  NOT NULL DEFAULT 'no_code',
  timeframe           VARCHAR(16)  NOT NULL DEFAULT 'swing',
  direction           VARCHAR(8)   NOT NULL DEFAULT 'long',
  definition_json     JSONB        NOT NULL,
  dsl_text            TEXT,
  status              VARCHAR(32)  NOT NULL DEFAULT 'draft',
  validated           BOOLEAN      NOT NULL DEFAULT FALSE,
  backtest_passed     BOOLEAN      NOT NULL DEFAULT FALSE,
  paper_deployed      BOOLEAN      NOT NULL DEFAULT FALSE,
  last_backtest_id    VARCHAR(64),
  version             INT          NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_strategies_user ON user_strategies (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_strategies_status ON user_strategies (status);

CREATE TABLE IF NOT EXISTS strategy_drafts (
  id                  VARCHAR(64)  PRIMARY KEY,
  user_id             VARCHAR(100),
  name                VARCHAR(255) NOT NULL DEFAULT 'Untitled Draft',
  source              VARCHAR(32)  NOT NULL DEFAULT 'no_code',
  definition_json     JSONB        NOT NULL,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_drafts_user ON strategy_drafts (user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS strategy_validation_logs (
  id                  BIGSERIAL PRIMARY KEY,
  strategy_id         VARCHAR(64)  NOT NULL,
  user_id             VARCHAR(100),
  valid               BOOLEAN      NOT NULL,
  issues_json         JSONB        NOT NULL DEFAULT '[]',
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_validation_logs_strategy
  ON strategy_validation_logs (strategy_id, created_at DESC);

-- strategy_conditions already exists (017) — user-built conditions sync on save
