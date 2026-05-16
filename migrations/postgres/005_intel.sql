-- ════════════════════════════════════════════════════════════════
--  intel schema — news, corporate events, forecasts, targets
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS intel.news (
  id              BIGSERIAL   PRIMARY KEY,
  external_id     TEXT        UNIQUE,          -- provider article id
  headline        TEXT        NOT NULL,
  summary         TEXT,
  source          TEXT        NOT NULL,
  url             TEXT,
  symbols         TEXT[]      NOT NULL DEFAULT '{}',
  sentiment       NUMERIC(5,2),
  impact_score    NUMERIC(5,2),
  categories      TEXT[]      NOT NULL DEFAULT '{}',
  raw_payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  published_at    TIMESTAMPTZ NOT NULL,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_news_published     ON intel.news (published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_symbols_gin   ON intel.news USING GIN (symbols);
CREATE INDEX IF NOT EXISTS idx_news_categories_gin ON intel.news USING GIN (categories);

CREATE TABLE IF NOT EXISTS intel.corporate_events (
  id           BIGSERIAL   PRIMARY KEY,
  symbol       TEXT        NOT NULL REFERENCES master.instruments(symbol) ON DELETE CASCADE,
  event_type   TEXT        NOT NULL,  -- dividend | split | bonus | merger | result
  event_date   DATE        NOT NULL,
  details      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  source       TEXT        NOT NULL,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (symbol, event_type, event_date)
);

CREATE INDEX IF NOT EXISTS idx_corp_events_symbol_date ON intel.corporate_events (symbol, event_date DESC);
CREATE INDEX IF NOT EXISTS idx_corp_events_type_date   ON intel.corporate_events (event_type, event_date DESC);

CREATE TABLE IF NOT EXISTS intel.announcements (
  id            BIGSERIAL   PRIMARY KEY,
  symbol        TEXT        NOT NULL REFERENCES master.instruments(symbol) ON DELETE CASCADE,
  title         TEXT        NOT NULL,
  category      TEXT,
  body          TEXT,
  attachment_url TEXT,
  announced_at  TIMESTAMPTZ NOT NULL,
  ingested_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_announcements_symbol_time ON intel.announcements (symbol, announced_at DESC);

CREATE TABLE IF NOT EXISTS intel.forecasts (
  id            BIGSERIAL   PRIMARY KEY,
  symbol        TEXT        NOT NULL REFERENCES master.instruments(symbol) ON DELETE CASCADE,
  analyst       TEXT        NOT NULL,
  forecast_type TEXT        NOT NULL,  -- 'revenue' | 'eps' | 'ebitda' | ...
  period        TEXT        NOT NULL,  -- 'Q1-FY27' | 'FY26' | ...
  value         NUMERIC(18,4),
  currency      TEXT        DEFAULT 'INR',
  issued_at     TIMESTAMPTZ NOT NULL,
  source        TEXT        NOT NULL,
  UNIQUE (symbol, analyst, forecast_type, period, issued_at)
);

CREATE INDEX IF NOT EXISTS idx_forecasts_symbol ON intel.forecasts (symbol, issued_at DESC);

CREATE TABLE IF NOT EXISTS intel.target_prices (
  id            BIGSERIAL   PRIMARY KEY,
  symbol        TEXT        NOT NULL REFERENCES master.instruments(symbol) ON DELETE CASCADE,
  analyst       TEXT        NOT NULL,
  rating        TEXT,       -- 'buy' | 'hold' | 'sell' | ...
  target_price  NUMERIC(18,4) NOT NULL,
  horizon_days  INTEGER,
  issued_at     TIMESTAMPTZ NOT NULL,
  source        TEXT        NOT NULL,
  UNIQUE (symbol, analyst, issued_at)
);

CREATE INDEX IF NOT EXISTS idx_target_prices_symbol ON intel.target_prices (symbol, issued_at DESC);

CREATE TABLE IF NOT EXISTS intel.statements (
  id            BIGSERIAL   PRIMARY KEY,
  symbol        TEXT        NOT NULL REFERENCES master.instruments(symbol) ON DELETE CASCADE,
  statement_type TEXT       NOT NULL,  -- 'income' | 'balance' | 'cashflow'
  period        TEXT        NOT NULL,
  data          JSONB       NOT NULL,
  currency      TEXT        DEFAULT 'INR',
  reported_at   TIMESTAMPTZ NOT NULL,
  source        TEXT        NOT NULL,
  UNIQUE (symbol, statement_type, period)
);

CREATE INDEX IF NOT EXISTS idx_statements_symbol_type ON intel.statements (symbol, statement_type);

COMMIT;
