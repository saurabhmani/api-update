-- Billing acceptance schema — canonical table names
-- Migration 026

CREATE TABLE IF NOT EXISTS user_wallets (
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

CREATE INDEX IF NOT EXISTS idx_user_wallets_user ON user_wallets (user_id);

CREATE TABLE IF NOT EXISTS credit_transactions (
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

CREATE INDEX IF NOT EXISTS idx_credit_tx_user ON credit_transactions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subscriptions (
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

CREATE TABLE IF NOT EXISTS user_plans (
  user_id           INT          PRIMARY KEY,
  plan              VARCHAR(32)  NOT NULL DEFAULT 'free',
  started_at        TIMESTAMPTZ  DEFAULT NOW(),
  expires_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS invoices (
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

CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id                VARCHAR(64)  PRIMARY KEY,
  user_id           INT          NOT NULL,
  invoice_id        VARCHAR(64),
  amount_inr        NUMERIC(12,2) NOT NULL,
  status            VARCHAR(24)  NOT NULL DEFAULT 'completed',
  payment_method    VARCHAR(32)  NOT NULL DEFAULT 'manual',
  reference_id      VARCHAR(128),
  metadata_json     JSONB,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_tx_user ON payment_transactions (user_id, created_at DESC);
