-- Strategy Lab — custom strategy definitions, audit trail, deployments
-- Migration 019

CREATE TABLE IF NOT EXISTS strategy_lab_definitions (
  id                  VARCHAR(64)  PRIMARY KEY,
  name                VARCHAR(255) NOT NULL,
  description         TEXT,
  source              VARCHAR(32)  NOT NULL DEFAULT 'no_code',
  timeframe           VARCHAR(16)  NOT NULL DEFAULT 'swing',
  direction           VARCHAR(8)   NOT NULL DEFAULT 'long',
  definition_json     JSONB        NOT NULL,
  dsl_text            TEXT,
  status              VARCHAR(32)  NOT NULL DEFAULT 'draft',
  validated           BOOLEAN      NOT NULL DEFAULT FALSE,
  validation_json     JSONB,
  last_backtest_id    VARCHAR(64),
  backtest_passed     BOOLEAN      NOT NULL DEFAULT FALSE,
  paper_deployed      BOOLEAN      NOT NULL DEFAULT FALSE,
  created_by          VARCHAR(100),
  version             INT          NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_lab_status ON strategy_lab_definitions (status);
CREATE INDEX IF NOT EXISTS idx_strategy_lab_validated ON strategy_lab_definitions (validated);

CREATE TABLE IF NOT EXISTS strategy_lab_audit (
  id              BIGSERIAL PRIMARY KEY,
  strategy_id     VARCHAR(64) NOT NULL REFERENCES strategy_lab_definitions(id) ON DELETE CASCADE,
  action          VARCHAR(64) NOT NULL,
  actor           VARCHAR(100),
  details_json    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_lab_audit_strategy ON strategy_lab_audit (strategy_id, created_at DESC);

CREATE TABLE IF NOT EXISTS strategy_lab_deployments (
  id              BIGSERIAL PRIMARY KEY,
  strategy_id     VARCHAR(64) NOT NULL REFERENCES strategy_lab_definitions(id) ON DELETE CASCADE,
  deployment_type VARCHAR(32) NOT NULL DEFAULT 'paper',
  status          VARCHAR(32) NOT NULL DEFAULT 'pending',
  gates_json      JSONB,
  approved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
