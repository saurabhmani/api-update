-- ════════════════════════════════════════════════════════════════
--  Security Acceptance — roles, permissions, events, consent_logs
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS auth.roles (
  id          SERIAL      PRIMARY KEY,
  name        TEXT        NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth.permissions (
  id          SERIAL      PRIMARY KEY,
  code        TEXT        NOT NULL UNIQUE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth.role_permissions (
  role_id       INTEGER NOT NULL REFERENCES auth.roles(id) ON DELETE CASCADE,
  permission_id INTEGER NOT NULL REFERENCES auth.permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS auth.security_events (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       INTEGER,
  actor_email   TEXT,
  event_type    TEXT        NOT NULL,
  action        TEXT        NOT NULL,
  resource      TEXT,
  severity      TEXT        NOT NULL DEFAULT 'info',
  detail_json   JSONB       DEFAULT '{}'::jsonb,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_security_events_time ON auth.security_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_security_events_type ON auth.security_events (event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS auth.consent_logs (
  id            BIGSERIAL   PRIMARY KEY,
  user_id       INTEGER     NOT NULL,
  consent_type  TEXT        NOT NULL,
  version       TEXT        NOT NULL,
  accepted      BOOLEAN     NOT NULL DEFAULT TRUE,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_consent_logs_user ON auth.consent_logs (user_id, created_at DESC);

COMMIT;
