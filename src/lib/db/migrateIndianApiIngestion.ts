/**
 * IndianAPI ingestion bookkeeping tables.
 *
 *   indianapi_ingestion_runs      — one row per ingestion run (audit /
 *                                   ops history, overlap forensics)
 *   indianapi_symbol_sync_state   — per-symbol per-dataset freshness +
 *                                   failure state; failed rows form the
 *                                   dead-letter set the repair job drains
 *
 * Safe to re-run (CREATE TABLE IF NOT EXISTS).
 */
import { db } from '../db';

const DDL_INGESTION_RUNS = `
  CREATE TABLE IF NOT EXISTS indianapi_ingestion_runs (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    run_id        VARCHAR(64)   NOT NULL,
    tier          VARCHAR(32)   NOT NULL,
    status        ENUM('running','completed','failed','skipped') NOT NULL DEFAULT 'running',
    started_at    DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    finished_at   DATETIME(3)   DEFAULT NULL,
    total_symbols INT           NOT NULL DEFAULT 0,
    processed     INT           NOT NULL DEFAULT 0,
    failed        INT           NOT NULL DEFAULT 0,
    api_calls     INT           NOT NULL DEFAULT 0,
    rate_limited  INT           NOT NULL DEFAULT 0,
    checkpoint    INT           NOT NULL DEFAULT 0,
    error_message VARCHAR(512)  DEFAULT NULL,
    UNIQUE KEY uq_iair_run (run_id),
    KEY idx_iair_tier_started (tier, started_at),
    KEY idx_iair_status (status, started_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

const DDL_SYMBOL_SYNC_STATE = `
  CREATE TABLE IF NOT EXISTS indianapi_symbol_sync_state (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol          VARCHAR(64)  NOT NULL,
    dataset         VARCHAR(32)  NOT NULL,
    last_success_at DATETIME(3)  DEFAULT NULL,
    last_attempt_at DATETIME(3)  DEFAULT NULL,
    consecutive_failures INT     NOT NULL DEFAULT 0,
    last_error      VARCHAR(512) DEFAULT NULL,
    updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_iass_symbol_dataset (symbol, dataset),
    KEY idx_iass_dataset_success (dataset, last_success_at),
    KEY idx_iass_failures (dataset, consecutive_failures)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

export async function migrateIndianApiIngestion(): Promise<void> {
  await db.query(DDL_INGESTION_RUNS);
  await db.query(DDL_SYMBOL_SYNC_STATE);
}

if (require.main === module) {
  void migrateIndianApiIngestion()
    .then(() => {
      console.log('[migrateIndianApiIngestion] done');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrateIndianApiIngestion] failed:', err);
      process.exit(1);
    });
}
