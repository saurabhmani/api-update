CREATE TABLE IF NOT EXISTS q365_maintenance_job_runs (
  id BIGSERIAL PRIMARY KEY,
  run_id VARCHAR(64) NOT NULL,
  job_name VARCHAR(80) NOT NULL,
  trading_date DATE NOT NULL,
  job_version VARCHAR(32) NOT NULL DEFAULT 'v1',
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','partial','failed','skipped')),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expected_count INTEGER,
  processed_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  dependency_run_ids JSONB,
  metadata_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_name, trading_date, job_version)
);
CREATE INDEX IF NOT EXISTS idx_maintenance_date_status
  ON q365_maintenance_job_runs (trading_date, status);
CREATE INDEX IF NOT EXISTS idx_maintenance_status_heartbeat
  ON q365_maintenance_job_runs (status, heartbeat_at);
CREATE INDEX IF NOT EXISTS idx_maintenance_run_id
  ON q365_maintenance_job_runs (run_id);

CREATE TABLE IF NOT EXISTS q365_daily_signal_reports (
  id BIGSERIAL PRIMARY KEY,
  report_date DATE NOT NULL UNIQUE,
  report_status VARCHAR(24) NOT NULL,
  data_status VARCHAR(24) NOT NULL,
  market_status VARCHAR(64),
  report_json JSONB NOT NULL,
  data_quality_json JSONB,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_q365_daily_reports_status
  ON q365_daily_signal_reports (report_status, report_date DESC);
