-- ════════════════════════════════════════════════════════════════
--  auth schema — users, sessions, audit
-- ════════════════════════════════════════════════════════════════

BEGIN;

-- CITEXT is created in 001 but this repeats it defensively so 002
-- is self-contained if anyone replays it in isolation.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE IF NOT EXISTS auth.users (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           CITEXT      UNIQUE NOT NULL,
  password_hash   TEXT        NOT NULL,
  display_name    TEXT,
  role            TEXT        NOT NULL DEFAULT 'user',
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  mfa_secret      TEXT,
  mfa_enabled     BOOLEAN     NOT NULL DEFAULT FALSE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- CITEXT (created in 001) gives case-insensitive email uniqueness
-- without a functional index on LOWER(email).

CREATE INDEX IF NOT EXISTS idx_users_active ON auth.users (is_active) WHERE is_active;

CREATE TABLE IF NOT EXISTS auth.sessions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash    TEXT        NOT NULL UNIQUE,
  user_agent    TEXT,
  ip_address    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sessions_user       ON auth.sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires    ON auth.sessions (expires_at) WHERE revoked_at IS NULL;

-- audit_logs: every privileged action (admin edits, MFA resets,
-- manual rejection overrides). Kept append-only; never UPDATE.
CREATE TABLE IF NOT EXISTS auth.audit_logs (
  id            BIGSERIAL   PRIMARY KEY,
  actor_user_id UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  action        TEXT        NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  metadata      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip_address    INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_actor_time   ON auth.audit_logs (actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action_time  ON auth.audit_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_metadata_gin ON auth.audit_logs USING GIN (metadata);

COMMIT;
