-- ════════════════════════════════════════════════════════════════
--  Security & Compliance — consent, audit, retention
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS auth.user_consents (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       INTEGER     NOT NULL,
  consent_type  TEXT        NOT NULL,
  version       TEXT        NOT NULL,
  accepted      BOOLEAN     NOT NULL DEFAULT TRUE,
  ip_address    TEXT,
  user_agent    TEXT,
  accepted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_user_consents_user ON auth.user_consents (user_id, consent_type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_consents_active ON auth.user_consents (user_id, consent_type, version) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth.security_audit_logs (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       INTEGER,
  actor_email   TEXT,
  event_type    TEXT        NOT NULL,
  action        TEXT        NOT NULL,
  resource      TEXT,
  detail_json   JSONB       DEFAULT '{}'::jsonb,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sec_audit_time ON auth.security_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sec_audit_user ON auth.security_audit_logs (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auth.data_retention_policies (
  id              SERIAL      PRIMARY KEY,
  data_category   TEXT        NOT NULL UNIQUE,
  retention_days  INTEGER     NOT NULL,
  description     TEXT,
  active          BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO auth.data_retention_policies (data_category, retention_days, description) VALUES
  ('audit_logs', 2555, '7 years — regulatory audit trail'),
  ('session_logs', 90, 'Session activity retention'),
  ('api_health_logs', 365, 'API health monitoring history'),
  ('user_consents', 2555, 'Consent records — indefinite until revoked'),
  ('security_events', 730, 'Security event log — 2 years')
ON CONFLICT (data_category) DO NOTHING;

COMMIT;
