// Dual-source market data audit tables.

import { db } from '../db';

const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS q365_dual_feed_raw (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(40) NOT NULL,
    source VARCHAR(20) NOT NULL,
    exchange VARCHAR(20) NOT NULL DEFAULT 'NSE',
    ltp DECIMAL(18,4) NOT NULL,
    open_price DECIMAL(18,4) DEFAULT NULL,
    high_price DECIMAL(18,4) DEFAULT NULL,
    low_price DECIMAL(18,4) DEFAULT NULL,
    close_price DECIMAL(18,4) DEFAULT NULL,
    volume BIGINT DEFAULT NULL,
    bid_price DECIMAL(18,4) DEFAULT NULL,
    ask_price DECIMAL(18,4) DEFAULT NULL,
    source_timestamp DATETIME(3) NOT NULL,
    received_at DATETIME(3) NOT NULL,
    latency_ms INT NOT NULL DEFAULT 0,
    payload_json JSON DEFAULT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_dual_raw_symbol_time (symbol, received_at),
    INDEX idx_dual_raw_source_time (source, received_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,

  `CREATE TABLE IF NOT EXISTS q365_dual_feed_validation (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol VARCHAR(40) NOT NULL,
    validated_at DATETIME(3) NOT NULL,
    validation_status VARCHAR(40) NOT NULL,
    approval_status VARCHAR(40) NOT NULL,
    confirmation_status VARCHAR(40) NOT NULL,
    confidence_score DECIMAL(6,2) NOT NULL DEFAULT 0,
    confidence_band VARCHAR(20) DEFAULT NULL,
    price_diff_bps DECIMAL(10,2) DEFAULT NULL,
    volume_diff_pct DECIMAL(10,2) DEFAULT NULL,
    timestamp_skew_ms INT DEFAULT NULL,
    yahoo_ltp DECIMAL(18,4) DEFAULT NULL,
    indian_ltp DECIMAL(18,4) DEFAULT NULL,
    authoritative_source VARCHAR(20) DEFAULT NULL,
    authoritative_ltp DECIMAL(18,4) DEFAULT NULL,
    reasons_json JSON DEFAULT NULL,
    metrics_json JSON DEFAULT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_dual_val_symbol_time (symbol, validated_at),
    INDEX idx_dual_val_status_time (validation_status, validated_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];

export async function migrateDualSource(): Promise<void> {
  for (const sql of DDL) {
    await db.query(sql);
  }
}
