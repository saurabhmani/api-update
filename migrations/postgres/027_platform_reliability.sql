-- ════════════════════════════════════════════════════════════════
--  Platform Reliability — health snapshots, alert deliveries, audit
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS ops.reliability_snapshots (
  id              BIGSERIAL   PRIMARY KEY,
  overall_status  TEXT        NOT NULL,   -- 'healthy' | 'degraded' | 'critical'
  metrics_json    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  alerts_json     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rel_snapshots_time ON ops.reliability_snapshots (created_at DESC);

CREATE TABLE IF NOT EXISTS ops.alert_deliveries (
  id              BIGSERIAL   PRIMARY KEY,
  alert_id        TEXT        NOT NULL,
  channel         TEXT        NOT NULL,   -- 'slack' | 'email' | 'system'
  severity        TEXT        NOT NULL,
  title           TEXT        NOT NULL,
  status          TEXT        NOT NULL,   -- 'sent' | 'failed' | 'skipped'
  error_message   TEXT,
  payload_json    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alert_deliveries_time ON ops.alert_deliveries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_deliveries_alert ON ops.alert_deliveries (alert_id);

CREATE TABLE IF NOT EXISTS ops.reliability_audit_logs (
  id              BIGSERIAL   PRIMARY KEY,
  actor_id        INTEGER,
  actor_email     TEXT,
  action          TEXT        NOT NULL,
  resource        TEXT,
  detail_json     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  ip_address      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rel_audit_time ON ops.reliability_audit_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rel_audit_action ON ops.reliability_audit_logs (action, created_at DESC);

COMMIT;
