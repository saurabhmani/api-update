-- Canonical strategy catalog tables (Strategy Hub acceptance schema)
-- Migration 017

-- Master strategy catalog (hub-facing)
CREATE TABLE IF NOT EXISTS strategies (
  id                  VARCHAR(64)  PRIMARY KEY,
  display_name        VARCHAR(128) NOT NULL,
  category            VARCHAR(32)  NOT NULL,
  direction           VARCHAR(8)   NOT NULL DEFAULT 'BUY',
  risk_profile        VARCHAR(32)  NOT NULL DEFAULT 'moderate',
  timeframe           VARCHAR(16)  NOT NULL DEFAULT 'swing',
  is_featured         BOOLEAN      NOT NULL DEFAULT FALSE,
  is_active           BOOLEAN      NOT NULL DEFAULT FALSE,
  paper_trading_ready BOOLEAN      NOT NULL DEFAULT FALSE,
  deployment_status   VARCHAR(32)  NOT NULL DEFAULT 'registered',
  explanation         TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_strategies_category ON strategies (category);
CREATE INDEX IF NOT EXISTS idx_strategies_featured ON strategies (is_featured) WHERE is_featured = TRUE;

-- Full registry metadata (mirrors signal-engine STRATEGY_REGISTRY)
CREATE TABLE IF NOT EXISTS strategy_registry (
  strategy_id         VARCHAR(64)  PRIMARY KEY REFERENCES strategies(id) ON DELETE CASCADE,
  entry_type          VARCHAR(64)  NOT NULL,
  signal_type         VARCHAR(64)  NOT NULL,
  confidence_weight   NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  allowed_regimes     JSONB        NOT NULL DEFAULT '[]',
  blocked_regimes     JSONB        NOT NULL DEFAULT '[]',
  ideal_market_regime JSONB        NOT NULL DEFAULT '[]',
  ideal_rsi_min       NUMERIC(5,2),
  ideal_rsi_max       NUMERIC(5,2),
  min_adx             NUMERIC(5,2),
  min_volume_expansion NUMERIC(5,2),
  invalidation_logic  TEXT,
  explanation_template TEXT,
  metadata_json       JSONB,
  version             VARCHAR(16)  NOT NULL DEFAULT '1.0.0',
  synced_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Per-strategy evaluation conditions (drives signal-engine gates)
CREATE TABLE IF NOT EXISTS strategy_conditions (
  id              BIGSERIAL PRIMARY KEY,
  strategy_id     VARCHAR(64) NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  condition_key   VARCHAR(64) NOT NULL,
  condition_label VARCHAR(128) NOT NULL,
  condition_type  VARCHAR(32) NOT NULL DEFAULT 'indicator',
  operator        VARCHAR(16),
  value_numeric   NUMERIC(12,4),
  value_text      TEXT,
  is_required     BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      INT NOT NULL DEFAULT 0,
  UNIQUE (strategy_id, condition_key)
);

CREATE INDEX IF NOT EXISTS idx_strategy_conditions_strategy
  ON strategy_conditions (strategy_id, sort_order);

-- Seed featured strategies (minimum 5 visible in hub)
INSERT INTO strategies (id, display_name, category, direction, risk_profile, timeframe, is_featured, is_active, paper_trading_ready, deployment_status, explanation)
VALUES
  ('bullish_breakout',      'Bullish Breakout',      'breakout',        'BUY', 'moderate',      'swing', TRUE, TRUE, TRUE, 'paper_ready', 'Price closed above resistance with improving momentum.'),
  ('momentum_continuation', 'Momentum Continuation', 'momentum',        'BUY', 'moderate_high', 'swing', TRUE, TRUE, TRUE, 'paper_ready', 'Momentum continues in the direction of the prevailing trend.'),
  ('bullish_pullback',      'Bullish Pullback',      'pullback',        'BUY', 'moderate',      'swing', TRUE, TRUE, TRUE, 'paper_ready', 'Pullback toward rising moving average in constructive trend.'),
  ('fibonacci_pullback',    'Fibonacci Pullback',    'pullback',        'BUY', 'moderate',      'swing', TRUE, TRUE, TRUE, 'paper_ready', 'Reaction from key Fibonacci retracement zone in bullish trend.'),
  ('ema_crossover',         'EMA Crossover',         'trend_following', 'BUY', 'moderate',      'swing', TRUE, TRUE, TRUE, 'paper_ready', 'Faster EMA crossed above slower EMA with constructive trend.')
ON CONFLICT (id) DO NOTHING;

INSERT INTO strategy_registry (strategy_id, entry_type, signal_type, confidence_weight, allowed_regimes, blocked_regimes, ideal_market_regime, ideal_rsi_min, ideal_rsi_max, min_adx, min_volume_expansion, invalidation_logic, explanation_template)
VALUES
  ('bullish_breakout', 'breakout_confirmation', 'bullish_breakout', 1.0,
   '["Strong Bullish","Bullish"]', '["Bearish","High Volatility Risk"]', '["Strong Bullish","Bullish"]', 55, 72, 20, 1.5,
   'Close below the prior resistance band invalidates the breakout structure.',
   'Price closed above resistance with improving momentum.'),
  ('momentum_continuation', 'momentum_continuation_entry', 'momentum_continuation', 1.0,
   '["Strong Bullish","Bullish"]', '["Bearish","Weak","High Volatility Risk"]', '["Strong Bullish","Bullish"]', 60, 78, 25, 0.8,
   'Loss of short-term trend support invalidates the continuation thesis.',
   'Momentum continues in the direction of the prevailing trend.'),
  ('bullish_pullback', 'pullback_entry', 'bullish_pullback', 0.95,
   '["Strong Bullish","Bullish","Sideways"]', '["Bearish","High Volatility Risk"]', '["Strong Bullish","Bullish"]', 40, 65, NULL, NULL,
   'Close below the rising moving average invalidates the pullback structure.',
   'Price is pulling back toward a rising moving average while the broader trend remains constructive.'),
  ('fibonacci_pullback', 'pullback_entry', 'fibonacci_pullback', 0.95,
   '["Strong Bullish","Bullish"]', '["Bearish","High Volatility Risk"]', '["Strong Bullish","Bullish"]', 42, 65, NULL, NULL,
   'Close below the 61.8% or 78.6% Fibonacci support zone invalidates the setup.',
   'Price is reacting from a key Fibonacci retracement zone inside a bullish trend.'),
  ('ema_crossover', 'trend_crossover_entry', 'ema_crossover', 0.85,
   '["Bullish","Strong Bullish","Sideways"]', '["Bearish","High Volatility Risk"]', '["Bullish","Strong Bullish"]', 45, 75, 18, 0.8,
   'Close back below the slower EMA invalidates the crossover.',
   'Faster EMA has crossed above the slower EMA while broader trend remains constructive.')
ON CONFLICT (strategy_id) DO NOTHING;

INSERT INTO strategy_conditions (strategy_id, condition_key, condition_label, condition_type, operator, value_numeric, value_text, sort_order)
VALUES
  ('bullish_breakout', 'regime_allowed',     'Allowed market regimes',     'regime',    'in',  NULL, 'Strong Bullish,Bullish', 1),
  ('bullish_breakout', 'min_volume_expansion','Minimum volume expansion',  'volume',    '>=',  1.5,  NULL, 2),
  ('bullish_breakout', 'ideal_rsi_range',    'Ideal RSI range',          'indicator', 'between', 55, '55-72', 3),
  ('bullish_breakout', 'min_adx',            'Minimum ADX',              'indicator', '>=',  20,   NULL, 4),
  ('momentum_continuation', 'regime_allowed', 'Allowed market regimes', 'regime',    'in',  NULL, 'Strong Bullish,Bullish', 1),
  ('momentum_continuation', 'min_adx',        'Minimum ADX',            'indicator', '>=',  25,   NULL, 2),
  ('momentum_continuation', 'ideal_rsi_range','Ideal RSI range',        'indicator', 'between', 60, '60-78', 3),
  ('bullish_pullback', 'regime_allowed',     'Allowed market regimes',   'regime',    'in',  NULL, 'Strong Bullish,Bullish,Sideways', 1),
  ('bullish_pullback', 'ideal_rsi_range',    'Ideal RSI range',          'indicator', 'between', 40, '40-65', 2),
  ('fibonacci_pullback', 'regime_allowed',   'Allowed market regimes',   'regime',    'in',  NULL, 'Strong Bullish,Bullish', 1),
  ('fibonacci_pullback', 'ideal_rsi_range',  'Ideal RSI range',          'indicator', 'between', 42, '42-65', 2),
  ('ema_crossover', 'regime_allowed',        'Allowed market regimes',   'regime',    'in',  NULL, 'Bullish,Strong Bullish,Sideways', 1),
  ('ema_crossover', 'min_adx',               'Minimum ADX',              'indicator', '>=',  18,   NULL, 2),
  ('ema_crossover', 'ideal_rsi_range',       'Ideal RSI range',          'indicator', 'between', 45, '45-75', 3)
ON CONFLICT (strategy_id, condition_key) DO NOTHING;

-- Backfill from legacy strategy_hub_profiles if present
INSERT INTO strategies (id, display_name, category, direction, risk_profile, paper_trading_ready, deployment_status)
SELECT p.strategy_id, p.strategy_id, 'breakout', 'BUY', COALESCE(p.risk_profile, 'moderate'), p.paper_trading_enabled, p.deployment_status
FROM strategy_hub_profiles p
WHERE NOT EXISTS (SELECT 1 FROM strategies s WHERE s.id = p.strategy_id)
ON CONFLICT (id) DO NOTHING;
