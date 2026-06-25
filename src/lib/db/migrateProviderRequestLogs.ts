/**
 * Provider request audit log — IndianAPI (and future providers).
 * Safe to re-run (CREATE TABLE IF NOT EXISTS).
 */
import { db } from '../db';

const DDL_PROVIDER_REQUEST_LOGS = `
  CREATE TABLE IF NOT EXISTS provider_request_logs (
    id             BIGINT AUTO_INCREMENT PRIMARY KEY,
    provider       VARCHAR(32)   NOT NULL DEFAULT 'indianapi',
    endpoint       VARCHAR(128)  NOT NULL,
    symbol         VARCHAR(64)   DEFAULT NULL,
    request_type   VARCHAR(64)   DEFAULT NULL,
    status_code    INT           DEFAULT NULL,
    success        TINYINT(1)    NOT NULL DEFAULT 0,
    error_message  VARCHAR(512)  DEFAULT NULL,
    requested_at   DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    job_id         VARCHAR(128)  DEFAULT NULL,
    source_job     VARCHAR(128)  DEFAULT NULL,
    response_count INT           DEFAULT NULL,
    KEY idx_prl_requested_at (requested_at),
    KEY idx_prl_provider_requested (provider, requested_at),
    KEY idx_prl_source_job (source_job, requested_at),
    KEY idx_prl_endpoint (endpoint, requested_at),
    KEY idx_prl_symbol (symbol, requested_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
`;

export async function migrateProviderRequestLogs(): Promise<void> {
  await db.query(DDL_PROVIDER_REQUEST_LOGS);
}

if (require.main === module) {
  void migrateProviderRequestLogs()
    .then(() => {
      console.log('[migrateProviderRequestLogs] done');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrateProviderRequestLogs] failed:', err);
      process.exit(1);
    });
}
