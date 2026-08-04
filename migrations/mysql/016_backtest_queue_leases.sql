-- Additive lease metadata for backtest_runs. MySQL remains authoritative.
ALTER TABLE backtest_runs
  ADD COLUMN processor_id VARCHAR(191) NULL,
  ADD COLUMN claimed_at DATETIME(3) NULL,
  ADD COLUMN heartbeat_at DATETIME(3) NULL,
  ADD COLUMN lease_expires_at DATETIME(3) NULL,
  ADD COLUMN attempt_count INT NOT NULL DEFAULT 0,
  ADD COLUMN max_attempts INT NOT NULL DEFAULT 3,
  ADD COLUMN cancellation_requested_at DATETIME(3) NULL,
  ADD COLUMN failure_category VARCHAR(64) NULL,
  ADD COLUMN last_error TEXT NULL,
  ADD COLUMN idempotency_key VARCHAR(191) NULL,
  ADD COLUMN worker_version VARCHAR(64) NULL,
  ADD COLUMN input_version VARCHAR(64) NULL,
  ADD COLUMN strategy_version VARCHAR(64) NULL;

CREATE INDEX idx_br_claimable ON backtest_runs (status, lease_expires_at, attempt_count, started_at);
CREATE INDEX idx_br_processor_lease ON backtest_runs (processor_id, status, lease_expires_at);
CREATE INDEX idx_br_idempotency ON backtest_runs (idempotency_key);
