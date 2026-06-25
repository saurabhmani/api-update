-- Quant Intelligence Platform — acceptance spec tables

BEGIN;

CREATE TABLE IF NOT EXISTS quant.research_reports (
  id                BIGSERIAL   PRIMARY KEY,
  user_id           INTEGER     NOT NULL,
  report_type       TEXT        NOT NULL,
  title             TEXT        NOT NULL,
  content_json      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  symbols           TEXT[],
  risk_warnings     TEXT[],
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quant.strategy_recommendations (
  id              BIGSERIAL   PRIMARY KEY,
  user_id         INTEGER,
  regime          TEXT        NOT NULL,
  recommendations JSONB       NOT NULL DEFAULT '[]'::jsonb,
  confidence      NUMERIC(5,2),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quant.portfolio_allocations (
  id              BIGSERIAL   PRIMARY KEY,
  user_id         INTEGER     NOT NULL,
  portfolio_id    INTEGER,
  allocations     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  metrics         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quant.sentiment_scores (
  id                BIGSERIAL   PRIMARY KEY,
  symbol            TEXT,
  overall_sentiment NUMERIC(6,3),
  bullish_count     INTEGER     NOT NULL DEFAULT 0,
  bearish_count     INTEGER     NOT NULL DEFAULT 0,
  neutral_count     INTEGER     NOT NULL DEFAULT 0,
  manipulation_risk NUMERIC(6,3),
  payload           JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quant.event_risk_scores (
  id                  BIGSERIAL   PRIMARY KEY,
  symbol              TEXT        NOT NULL,
  overall_risk        NUMERIC(5,2) NOT NULL,
  event_category      TEXT,
  suppress_trade      BOOLEAN     NOT NULL DEFAULT FALSE,
  news_event_risk     NUMERIC(5,2),
  manipulation_score  NUMERIC(5,2),
  reasons             JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quant.enterprise_reports (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       INTEGER     NOT NULL,
  report_type   TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'completed',
  payload_json  JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quant.api_clients (
  id            BIGSERIAL   PRIMARY KEY,
  name          TEXT        NOT NULL,
  user_id       INTEGER     NOT NULL,
  plan          TEXT        NOT NULL DEFAULT 'free',
  active        BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quant.api_keys (
  id            BIGSERIAL   PRIMARY KEY,
  client_id     BIGINT      NOT NULL REFERENCES quant.api_clients(id),
  key_hash      TEXT        NOT NULL UNIQUE,
  key_prefix    TEXT        NOT NULL,
  scopes        TEXT[]      NOT NULL DEFAULT '{}',
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);

COMMIT;
