-- Data-source broker_connections + pending OAuth transactions (MySQL)
-- Migration 014
--
-- Additive / idempotent. Does not drop legacy broker_accounts or broker_tokens.
-- Legacy token copy is performed lazily by migrateLegacyBrokerDataForUser()
-- so this file remains safe when legacy tables do not exist.

CREATE TABLE IF NOT EXISTS broker_connections (
  id VARCHAR(64) PRIMARY KEY,
  user_id INT NOT NULL,
  broker VARCHAR(32) NOT NULL,
  broker_account_id VARCHAR(64) NULL,
  broker_user_name VARCHAR(128) NULL,
  access_token_encrypted TEXT NULL,
  refresh_token_encrypted TEXT NULL,
  token_expires_at DATETIME NULL,
  last_authenticated_at DATETIME NULL,
  last_used_at DATETIME NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'disconnected',
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  metadata JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_broker_connections_user_broker (user_id, broker),
  INDEX idx_broker_connections_user (user_id),
  INDEX idx_broker_connections_broker (broker),
  INDEX idx_broker_connections_status (status),
  INDEX idx_broker_connections_expires (token_expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional FK (skipped silently when users table / engine constraints block it).
-- Boot-time ensureBrokerConnectionTables() also attempts the FK.
-- ALTER TABLE broker_connections
--   ADD CONSTRAINT fk_broker_connections_user
--   FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS broker_auth_transactions (
  id VARCHAR(64) PRIMARY KEY,
  user_id INT NOT NULL,
  broker VARCHAR(32) NOT NULL,
  state_hash VARCHAR(128) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  expires_at DATETIME NOT NULL,
  completed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_broker_auth_tx_user (user_id),
  INDEX idx_broker_auth_tx_status (status),
  INDEX idx_broker_auth_tx_expires (expires_at),
  INDEX idx_broker_auth_tx_state (state_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
