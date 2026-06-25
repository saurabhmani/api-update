-- ════════════════════════════════════════════════════════════════
--  Admin Monitoring — canonical acceptance tables
-- ════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS ops.cron_job_logs (
  id            BIGSERIAL   PRIMARY KEY,
  job_name      TEXT        NOT NULL,
  job_label     TEXT,
  status        TEXT        NOT NULL,   -- 'success' | 'failed' | 'running'
  duration_ms   INTEGER,
  error_message TEXT,
  metadata_json JSONB       DEFAULT '{}'::jsonb,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cron_job_logs_time ON ops.cron_job_logs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_job_logs_name ON ops.cron_job_logs (job_name, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_job_logs_failed ON ops.cron_job_logs (status, started_at DESC) WHERE status = 'failed';

CREATE TABLE IF NOT EXISTS ops.api_health_logs (
  id              BIGSERIAL   PRIMARY KEY,
  route           TEXT,
  status          TEXT        NOT NULL,   -- 'ok' | 'degraded' | 'fail'
  error_rate      NUMERIC(8,4),
  avg_latency_ms  INTEGER,
  uptime_pct      NUMERIC(6,2),
  quota_state     TEXT,
  details_json    JSONB       DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_health_logs_time ON ops.api_health_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS ops.system_health_logs (
  id              BIGSERIAL   PRIMARY KEY,
  overall_status  TEXT        NOT NULL,
  metrics_json    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  data_delay_sec  INTEGER,
  cron_failures   INTEGER     DEFAULT 0,
  strategy_failures INTEGER   DEFAULT 0,
  alert_count     INTEGER     DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_system_health_logs_time ON ops.system_health_logs (created_at DESC);

CREATE TABLE IF NOT EXISTS ops.admin_actions (
  id            BIGSERIAL   PRIMARY KEY,
  actor_id      INTEGER,
  actor_email   TEXT,
  action        TEXT        NOT NULL,
  resource      TEXT,
  detail_json   JSONB       DEFAULT '{}'::jsonb,
  ip_address    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_time ON ops.admin_actions (created_at DESC);

CREATE TABLE IF NOT EXISTS ops.alerts (
  id            BIGSERIAL   PRIMARY KEY,
  alert_key     TEXT        NOT NULL,
  severity      TEXT        NOT NULL,
  title         TEXT        NOT NULL,
  message       TEXT        NOT NULL,
  source        TEXT        NOT NULL DEFAULT 'admin_monitor',
  status        TEXT        NOT NULL DEFAULT 'active',
  context_json  JSONB       DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ops_alerts_time ON ops.alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_alerts_active ON ops.alerts (status, severity, created_at DESC) WHERE status = 'active';
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_alerts_key ON ops.alerts (alert_key) WHERE status = 'active';

COMMIT;
