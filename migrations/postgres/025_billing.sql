-- SaaS Billing Platform — subscriptions, wallets, usage, invoices
-- Migration 025

CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id                VARCHAR(64)  PRIMARY KEY,
  user_id           INT          NOT NULL UNIQUE,
  plan              VARCHAR(32)  NOT NULL DEFAULT 'free',
  status            VARCHAR(24)  NOT NULL DEFAULT 'active',
  billing_cycle     VARCHAR(16)  NOT NULL DEFAULT 'monthly',
  price_inr         NUMERIC(12,2) NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  provider          VARCHAR(32),
  provider_sub_id   VARCHAR(128),
  metadata_json     JSONB,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_subs_plan ON billing_subscriptions (plan, status);

CREATE TABLE IF NOT EXISTS billing_wallets (
  id                VARCHAR(64)  PRIMARY KEY,
  user_id           INT          NOT NULL,
  credit_type       VARCHAR(32)  NOT NULL,
  balance           INT          NOT NULL DEFAULT 0,
  monthly_allocation INT         NOT NULL DEFAULT 0,
  last_reset_at     DATE,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, credit_type)
);

CREATE INDEX IF NOT EXISTS idx_billing_wallets_user ON billing_wallets (user_id);

CREATE TABLE IF NOT EXISTS billing_wallet_transactions (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INT          NOT NULL,
  credit_type       VARCHAR(32)  NOT NULL,
  amount            INT          NOT NULL,
  balance_after     INT          NOT NULL,
  reason            VARCHAR(64)  NOT NULL,
  reference_id      VARCHAR(64),
  actor             VARCHAR(100),
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wallet_tx_user ON billing_wallet_transactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_usage_events (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INT          NOT NULL,
  credit_type       VARCHAR(32)  NOT NULL,
  feature_key       VARCHAR(64),
  quantity          INT          NOT NULL DEFAULT 1,
  metadata_json     JSONB,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_user ON billing_usage_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_type ON billing_usage_events (credit_type, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_invoices (
  id                VARCHAR(64)  PRIMARY KEY,
  user_id           INT          NOT NULL,
  invoice_number    VARCHAR(32)  NOT NULL UNIQUE,
  plan              VARCHAR(32)  NOT NULL,
  subtotal_inr      NUMERIC(12,2) NOT NULL,
  tax_inr           NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_inr         NUMERIC(12,2) NOT NULL,
  status            VARCHAR(24)  NOT NULL DEFAULT 'draft',
  period_start      DATE,
  period_end        DATE,
  paid_at           TIMESTAMPTZ,
  due_at            TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_user ON billing_invoices (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_invoice_items (
  id                BIGSERIAL PRIMARY KEY,
  invoice_id        VARCHAR(64)  NOT NULL REFERENCES billing_invoices(id) ON DELETE CASCADE,
  description       TEXT NOT NULL,
  quantity          INT NOT NULL DEFAULT 1,
  unit_price_inr    NUMERIC(12,2) NOT NULL,
  total_inr         NUMERIC(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS billing_admin_overrides (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INT          NOT NULL,
  override_type     VARCHAR(32) NOT NULL,
  override_value    VARCHAR(128) NOT NULL,
  reason            TEXT,
  actor             VARCHAR(100) NOT NULL,
  expires_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_override_user ON billing_admin_overrides (user_id);
