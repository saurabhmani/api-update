-- Strategy Hub — deployment profiles and metadata persistence
-- Migration 016

CREATE TABLE IF NOT EXISTS strategy_hub_profiles (
  strategy_id           VARCHAR(64) PRIMARY KEY,
  deployment_status     VARCHAR(32)  NOT NULL DEFAULT 'registered',
  paper_trading_enabled BOOLEAN      NOT NULL DEFAULT FALSE,
  risk_profile          VARCHAR(32),
  metadata_json         JSONB,
  version               VARCHAR(16)  NOT NULL DEFAULT '1.0.0',
  notes                 TEXT,
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategy_hub_deployment
  ON strategy_hub_profiles (deployment_status);

-- Seed initial featured strategies (paper-trading ready)
INSERT INTO strategy_hub_profiles (strategy_id, deployment_status, paper_trading_enabled, risk_profile, version, notes)
VALUES
  ('bullish_breakout',      'paper_ready', TRUE, 'moderate',      '1.0.0', 'Featured swing strategy — breakout confirmation'),
  ('momentum_continuation', 'paper_ready', TRUE, 'moderate_high', '1.0.0', 'Featured swing strategy — trend momentum'),
  ('bullish_pullback',      'paper_ready', TRUE, 'moderate',      '1.0.0', 'Featured swing strategy — EMA pullback'),
  ('fibonacci_pullback',    'paper_ready', TRUE, 'moderate',      '1.0.0', 'Featured swing strategy — Fibonacci retracement'),
  ('ema_crossover',         'paper_ready', TRUE, 'moderate',      '1.0.0', 'Featured swing strategy — EMA crossover')
ON CONFLICT (strategy_id) DO NOTHING;
