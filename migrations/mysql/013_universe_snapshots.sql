-- ════════════════════════════════════════════════════════════════
--  Universe snapshot + rebuild audit (MySQL)
--
--  Weekly NSE 1000 auto-rebuild persists churn decisions here.
--  Safe to run before app deploy — CREATE IF NOT EXISTS only.
-- ════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS universe_snapshots (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  snapshot_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  trigger_source VARCHAR(64) NOT NULL,
  target_size    INT NOT NULL,
  active_count   INT NOT NULL DEFAULT 0,
  added_count    INT NOT NULL DEFAULT 0,
  removed_count  INT NOT NULL DEFAULT 0,
  kept_count     INT NOT NULL DEFAULT 0,
  dry_run        TINYINT(1) NOT NULL DEFAULT 0,
  ok             TINYINT(1) NOT NULL DEFAULT 1,
  summary_json   JSON DEFAULT NULL,
  INDEX idx_universe_snapshots_at (snapshot_at),
  INDEX idx_universe_snapshots_trigger (trigger_source, snapshot_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS universe_snapshot_symbols (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  snapshot_id      INT NOT NULL,
  symbol           VARCHAR(32) NOT NULL,
  rank_position    INT DEFAULT NULL,
  composite_score  DECIMAL(12,6) DEFAULT NULL,
  action           ENUM('add','keep','remove') NOT NULL,
  data_quality_ok  TINYINT(1) NOT NULL DEFAULT 0,
  is_active        TINYINT(1) NOT NULL DEFAULT 0,
  reason           VARCHAR(255) DEFAULT NULL,
  UNIQUE KEY uq_snapshot_symbol (snapshot_id, symbol),
  INDEX idx_snapshot_symbols_action (snapshot_id, action),
  INDEX idx_snapshot_symbols_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS universe_rebuild_logs (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  started_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at   DATETIME DEFAULT NULL,
  trigger_source VARCHAR(64) NOT NULL,
  dry_run        TINYINT(1) NOT NULL DEFAULT 0,
  ok             TINYINT(1) NOT NULL DEFAULT 0,
  target_size    INT NOT NULL,
  snapshot_id    INT DEFAULT NULL,
  blockers_json  JSON DEFAULT NULL,
  summary_json   JSON DEFAULT NULL,
  duration_ms    INT DEFAULT NULL,
  INDEX idx_universe_rebuild_started (started_at),
  INDEX idx_universe_rebuild_trigger (trigger_source, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
