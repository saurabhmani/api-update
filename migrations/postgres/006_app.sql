-- ════════════════════════════════════════════════════════════════
--  app schema — user-facing entities (watchlists, portfolios, alerts)
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS app.watchlists (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT        NOT NULL,
  symbols     TEXT[]      NOT NULL DEFAULT '{}',
  is_default  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_watchlists_user ON app.watchlists (user_id);

CREATE TABLE IF NOT EXISTS app.portfolios (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name          TEXT        NOT NULL,
  base_currency TEXT        NOT NULL DEFAULT 'INR',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, name)
);

CREATE INDEX IF NOT EXISTS idx_portfolios_user ON app.portfolios (user_id);

CREATE TABLE IF NOT EXISTS app.portfolio_holdings (
  id             BIGSERIAL   PRIMARY KEY,
  portfolio_id   UUID        NOT NULL REFERENCES app.portfolios(id) ON DELETE CASCADE,
  symbol         TEXT        NOT NULL REFERENCES master.instruments(symbol) ON DELETE RESTRICT,
  quantity       NUMERIC(18,4) NOT NULL,
  avg_price      NUMERIC(18,4) NOT NULL,
  opened_at      TIMESTAMPTZ NOT NULL,
  closed_at      TIMESTAMPTZ,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_holdings_portfolio ON app.portfolio_holdings (portfolio_id);
CREATE INDEX IF NOT EXISTS idx_holdings_open
  ON app.portfolio_holdings (portfolio_id, symbol) WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS app.alerts (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol        TEXT        NOT NULL REFERENCES master.instruments(symbol) ON DELETE CASCADE,
  condition     TEXT        NOT NULL,    -- 'price_above' | 'price_below' | 'volume_spike' | ...
  threshold     NUMERIC(18,4),
  status        TEXT        NOT NULL DEFAULT 'active',  -- 'active' | 'triggered' | 'expired'
  triggered_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alerts_user_status   ON app.alerts (user_id, status);
CREATE INDEX IF NOT EXISTS idx_alerts_symbol_status ON app.alerts (symbol, status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS app.reports (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_type   TEXT        NOT NULL,
  params        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  payload       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  file_url      TEXT,
  generated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reports_user_time ON app.reports (user_id, generated_at DESC);

COMMIT;
