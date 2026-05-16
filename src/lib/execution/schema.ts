// ════════════════════════════════════════════════════════════════
//  Execution engine DB schema
//
//  Three tables govern the live trading pipeline end-to-end:
//
//    q365_exec_signals   — every signal the strategy engine emits.
//                          Immutable log; a row is created before
//                          risk checks so we can audit rejections.
//
//    q365_exec_trades    — one row per order sent to the broker.
//                          Keyed by broker order_id (unique). The
//                          postback webhook updates this row as
//                          the order moves COMPLETE / CANCELLED /
//                          REJECTED. Includes 'role' so entry,
//                          stop, and target orders for the same
//                          position are linked.
//
//    q365_exec_positions — open + closed positions. One row per
//                          round-trip. Updated on entry fill,
//                          updated again on exit fill, pnl computed
//                          on close.
//
//  ensureExecutionSchema() is idempotent — called from bootTicker
//  once per process. It CREATE TABLE IF NOT EXISTS, so existing
//  installations are safe.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import { db } from '@/lib/db';

const log = logger.child({ component: 'executionSchema' });

let schemaEnsured = false;

export async function ensureExecutionSchema(): Promise<void> {
  if (schemaEnsured) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_exec_signals (
      id              INT           NOT NULL AUTO_INCREMENT,
      symbol          VARCHAR(64)   NOT NULL,
      side            ENUM('BUY','SELL') NOT NULL,
      price           DECIMAL(12,4) NOT NULL,
      confidence      DECIMAL(6,2)  NULL,
      strategy        VARCHAR(64)   NULL,
      stop_loss       DECIMAL(12,4) NULL,
      target_1        DECIMAL(12,4) NULL,
      engine_entry    DECIMAL(12,4) NULL,
      volume          BIGINT        NULL,
      outcome         VARCHAR(32)   NOT NULL DEFAULT 'emitted',
      outcome_reason  VARCHAR(255)  NULL,
      created_at      DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_symbol_ts (symbol, created_at),
      INDEX idx_outcome (outcome)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_exec_trades (
      id                INT           NOT NULL AUTO_INCREMENT,
      order_id          VARCHAR(64)   NOT NULL,
      parent_order_id   VARCHAR(64)   NULL,
      symbol            VARCHAR(64)   NOT NULL,
      side              ENUM('BUY','SELL') NOT NULL,
      role              ENUM('ENTRY','STOP','TARGET') NOT NULL DEFAULT 'ENTRY',
      quantity          INT           NOT NULL,
      requested_price   DECIMAL(12,4) NULL,
      average_price     DECIMAL(12,4) NULL,
      filled_quantity   INT           NOT NULL DEFAULT 0,
      pending_quantity  INT           NULL,
      status            VARCHAR(32)   NOT NULL,
      status_message    VARCHAR(255)  NULL,
      product           VARCHAR(16)   NULL,
      order_type        VARCHAR(16)   NULL,
      trigger_price     DECIMAL(12,4) NULL,
      position_id       INT           NULL,
      signal_id         INT           NULL,
      dry_run           TINYINT(1)    NOT NULL DEFAULT 1,
      error             TEXT          NULL,
      placed_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      exchange_ts       DATETIME      NULL,
      updated_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uq_order_id (order_id),
      INDEX idx_symbol (symbol),
      INDEX idx_status (status),
      INDEX idx_position (position_id),
      INDEX idx_signal (signal_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_exec_positions (
      id                INT           NOT NULL AUTO_INCREMENT,
      symbol            VARCHAR(64)   NOT NULL,
      side              ENUM('BUY','SELL') NOT NULL,
      quantity          INT           NOT NULL,
      filled_quantity   INT           NOT NULL DEFAULT 0,
      requested_price   DECIMAL(12,4) NULL,
      entry_price       DECIMAL(12,4) NULL,
      exit_price        DECIMAL(12,4) NULL,
      stop_loss         DECIMAL(12,4) NULL,
      target_1          DECIMAL(12,4) NULL,
      pnl               DECIMAL(14,4) NULL,
      pnl_pct           DECIMAL(10,4) NULL,
      status            ENUM('PENDING','OPEN','CLOSED','CANCELLED') NOT NULL DEFAULT 'PENDING',
      exit_reason       VARCHAR(32)   NULL,
      entry_order_id    VARCHAR(64)   NULL,
      stop_order_id     VARCHAR(64)   NULL,
      target_order_id   VARCHAR(64)   NULL,
      entry_signal_id   INT           NULL,
      strategy          VARCHAR(64)   NULL,
      dry_run           TINYINT(1)    NOT NULL DEFAULT 1,
      opened_at         DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      filled_at         DATETIME      NULL,
      closed_at         DATETIME      NULL,
      PRIMARY KEY (id),
      INDEX idx_symbol_status (symbol, status),
      INDEX idx_status (status),
      INDEX idx_entry_order (entry_order_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  schemaEnsured = true;
  console.log('[execution] schema ensured (signals/trades/positions)');
}
