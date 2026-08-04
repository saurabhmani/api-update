-- Staging/integration ownership authority. Applying this migration in production requires separate approval.
CREATE TABLE IF NOT EXISTS backtest_processor_ownership (
  singleton_id TINYINT NOT NULL PRIMARY KEY,
  owner ENUM('monolith','service','disabled') NOT NULL,
  epoch BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  updated_by VARCHAR(191) NOT NULL,
  CONSTRAINT chk_backtest_owner_singleton CHECK (singleton_id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO backtest_processor_ownership(singleton_id,owner,epoch,updated_at,updated_by)
VALUES (1,'monolith',1,NOW(3),'migration-017');

ALTER TABLE backtest_runs
  ADD COLUMN ownership_epoch BIGINT UNSIGNED NULL,
  ADD COLUMN processor_type ENUM('monolith','service') NULL;
CREATE INDEX idx_br_processor_epoch_lease ON backtest_runs(processor_id,ownership_epoch,status,lease_expires_at);
