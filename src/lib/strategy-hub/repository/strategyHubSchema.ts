// ════════════════════════════════════════════════════════════════
//  Strategy Hub — MySQL schema ensure (profiles + deployment history)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';

let _ensured = false;

export async function ensureStrategyHubTables(): Promise<void> {
  if (_ensured) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_profiles (
      strategy_id           VARCHAR(64)  NOT NULL PRIMARY KEY,
      deployment_status     VARCHAR(32)  NOT NULL DEFAULT 'draft',
      paper_trading_enabled TINYINT(1)   NOT NULL DEFAULT 0,
      risk_profile          VARCHAR(32)  DEFAULT NULL,
      metadata_json         JSON         DEFAULT NULL,
      version               VARCHAR(16)  NOT NULL DEFAULT '1.0.0',
      notes                 TEXT         DEFAULT NULL,
      updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_hub_deployment (deployment_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_deployment_history (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      strategy_id   VARCHAR(64)  NOT NULL,
      user_id       INT          NOT NULL,
      from_status   VARCHAR(32)  DEFAULT NULL,
      to_status     VARCHAR(32)  NOT NULL,
      environment   VARCHAR(16)  NOT NULL DEFAULT 'paper',
      event_type    VARCHAR(32)  NOT NULL,
      actor         VARCHAR(255) DEFAULT NULL,
      details_json  JSON         DEFAULT NULL,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_deploy_hist_strategy (strategy_id, created_at),
      INDEX idx_deploy_hist_user (user_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_mode_history (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      strategy_id   VARCHAR(64)  NOT NULL,
      user_id       INT          NOT NULL,
      from_mode     VARCHAR(32)  DEFAULT NULL,
      to_mode       VARCHAR(32)  NOT NULL,
      reason        TEXT         DEFAULT NULL,
      source        VARCHAR(16)  NOT NULL DEFAULT 'ui',
      actor         VARCHAR(255) DEFAULT NULL,
      details_json  JSON         DEFAULT NULL,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_mode_hist_strategy (strategy_id, created_at),
      INDEX idx_mode_hist_user (user_id, created_at),
      INDEX idx_mode_hist_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_config_history (
      id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
      strategy_id           VARCHAR(64)  NOT NULL,
      user_id               INT          NOT NULL,
      version_number        INT          NOT NULL,
      previous_values_json  JSON         DEFAULT NULL,
      new_values_json       JSON         DEFAULT NULL,
      change_summary        TEXT         NOT NULL,
      reason                TEXT         DEFAULT NULL,
      actor                 VARCHAR(255) DEFAULT NULL,
      source                VARCHAR(16)  NOT NULL DEFAULT 'ui',
      created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_config_hist_strategy (strategy_id, version_number),
      INDEX idx_config_hist_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_validation_history (
      id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
      strategy_id           VARCHAR(64)  NOT NULL,
      user_id               INT          NOT NULL,
      validation_target     VARCHAR(16)  NOT NULL DEFAULT 'assessment',
      overall_status        VARCHAR(16)  NOT NULL,
      validation_score      INT          NOT NULL DEFAULT 0,
      report_json           JSON         NOT NULL,
      effective_config_json JSON         DEFAULT NULL,
      config_version        INT          NOT NULL DEFAULT 0,
      execution_time_ms     INT          NOT NULL DEFAULT 0,
      actor                 VARCHAR(255) DEFAULT NULL,
      created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_valid_hist_strategy (strategy_id, created_at),
      INDEX idx_valid_hist_status (overall_status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_alerts (
      id                BIGINT AUTO_INCREMENT PRIMARY KEY,
      alert_key         VARCHAR(128) NOT NULL,
      severity          VARCHAR(16)  NOT NULL DEFAULT 'warning',
      strategy_id       VARCHAR(64)  DEFAULT NULL,
      title             VARCHAR(255) NOT NULL,
      description       TEXT         NOT NULL,
      suggested_action  TEXT         DEFAULT NULL,
      status            VARCHAR(16)  NOT NULL DEFAULT 'open',
      acknowledged_at   DATETIME     DEFAULT NULL,
      acknowledged_by   VARCHAR(255) DEFAULT NULL,
      resolved_at       DATETIME     DEFAULT NULL,
      resolved_by       VARCHAR(255) DEFAULT NULL,
      details_json      JSON         DEFAULT NULL,
      created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_alert_key_open (alert_key, status),
      INDEX idx_hub_alerts_status (status, created_at),
      INDEX idx_hub_alerts_strategy (strategy_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_automation_settings (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      settings_json JSON         NOT NULL,
      updated_by    VARCHAR(255) DEFAULT NULL,
      updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_ops_events (
      id            BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_type    VARCHAR(64)  NOT NULL,
      strategy_id   VARCHAR(64)  DEFAULT NULL,
      severity      VARCHAR(16)  NOT NULL DEFAULT 'info',
      title         VARCHAR(255) NOT NULL,
      description   TEXT         DEFAULT NULL,
      actor         VARCHAR(255) DEFAULT NULL,
      details_json  JSON         DEFAULT NULL,
      created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_ops_events_type (event_type, created_at),
      INDEX idx_ops_events_strategy (strategy_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_ai_recommendations (
      id               BIGINT AUTO_INCREMENT PRIMARY KEY,
      strategy_id      VARCHAR(64)  NOT NULL,
      rec_key          VARCHAR(160) NOT NULL,
      category         VARCHAR(32)  NOT NULL,
      action           VARCHAR(512) NOT NULL,
      reason           TEXT         NOT NULL,
      evidence_json    JSON         DEFAULT NULL,
      expected_impact  TEXT         DEFAULT NULL,
      confidence_level VARCHAR(16)  NOT NULL DEFAULT 'low',
      apply_mode       VARCHAR(32)  NOT NULL DEFAULT 'advisory',
      target_mode      VARCHAR(32)  DEFAULT NULL,
      status           VARCHAR(16)  NOT NULL DEFAULT 'active',
      applied_by       VARCHAR(255) DEFAULT NULL,
      applied_at       DATETIME     DEFAULT NULL,
      created_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_ai_rec_strategy_key (strategy_id, rec_key),
      INDEX idx_ai_recs_strategy (strategy_id, status, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_portfolio_settings (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      total_capital  DECIMAL(18,2) NOT NULL DEFAULT 1000000.00,
      currency       VARCHAR(8)    NOT NULL DEFAULT 'INR',
      updated_by     VARCHAR(255)  DEFAULT NULL,
      updated_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_capital_allocations (
      strategy_id       VARCHAR(64)   NOT NULL PRIMARY KEY,
      allocation_method VARCHAR(32)   NOT NULL DEFAULT 'manual',
      allocated_amount  DECIMAL(18,2) NOT NULL DEFAULT 0.00,
      allocated_pct     DECIMAL(8,4)  NOT NULL DEFAULT 0.0000,
      is_active         TINYINT(1)    NOT NULL DEFAULT 1,
      updated_by        VARCHAR(255)  DEFAULT NULL,
      updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_allocation_history (
      id              BIGINT AUTO_INCREMENT PRIMARY KEY,
      strategy_id     VARCHAR(64)   NOT NULL,
      from_amount     DECIMAL(18,2) NOT NULL DEFAULT 0.00,
      to_amount       DECIMAL(18,2) NOT NULL DEFAULT 0.00,
      from_pct        DECIMAL(8,4)  NOT NULL DEFAULT 0.0000,
      to_pct          DECIMAL(8,4)  NOT NULL DEFAULT 0.0000,
      method          VARCHAR(32)   NOT NULL DEFAULT 'manual',
      reason          TEXT          DEFAULT NULL,
      actor           VARCHAR(255)  DEFAULT NULL,
      created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_alloc_hist_strategy (strategy_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS strategy_hub_portfolio_alerts (
      id                BIGINT AUTO_INCREMENT PRIMARY KEY,
      alert_key         VARCHAR(128) NOT NULL,
      alert_type        VARCHAR(32)  NOT NULL,
      severity          VARCHAR(16)  NOT NULL DEFAULT 'warning',
      strategy_id       VARCHAR(64)  DEFAULT NULL,
      title             VARCHAR(255) NOT NULL,
      description       TEXT         NOT NULL,
      suggested_action  TEXT         DEFAULT NULL,
      status            VARCHAR(16)  NOT NULL DEFAULT 'open',
      acknowledged_at   DATETIME     DEFAULT NULL,
      acknowledged_by   VARCHAR(255) DEFAULT NULL,
      resolved_at       DATETIME     DEFAULT NULL,
      resolved_by       VARCHAR(255) DEFAULT NULL,
      created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_portfolio_alerts_status (status, created_at),
      INDEX idx_portfolio_alerts_key (alert_key, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  _ensured = true;
}

/** Reset cache for tests. */
export function _resetStrategyHubSchemaCache(): void {
  _ensured = false;
}
