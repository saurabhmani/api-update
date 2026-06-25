// Broker Integration — MySQL persistence

import { v4 as uuidv4 } from 'uuid';
import { db } from '@/lib/db';
import { decrypt, encrypt } from '@/lib/encryption';
import type { BrokerCredentials, BrokerHealthSnapshot, BrokerName } from '../types';

let migrated = false;

export async function ensureBrokerTables(): Promise<void> {
  if (migrated) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS broker_accounts (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        broker VARCHAR(32) NOT NULL DEFAULT 'simulated',
        status VARCHAR(24) NOT NULL DEFAULT 'disconnected',
        broker_user_id VARCHAR(64),
        metadata_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_broker_accounts_user (user_id, broker),
        INDEX idx_broker_accounts_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS broker_tokens (
        id VARCHAR(64) PRIMARY KEY,
        account_id VARCHAR(64) NOT NULL,
        user_id INT NOT NULL,
        access_token_enc TEXT,
        refresh_token_enc TEXT,
        token_expires_at DATETIME,
        last_refresh_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_broker_tokens_account (account_id),
        INDEX idx_broker_tokens_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS live_orders (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        broker VARCHAR(32) NOT NULL,
        broker_order_id VARCHAR(64),
        symbol VARCHAR(32) NOT NULL,
        side VARCHAR(8) NOT NULL,
        order_type VARCHAR(16) NOT NULL,
        quantity INT NOT NULL,
        filled_qty INT NOT NULL DEFAULT 0,
        price DECIMAL(14,4),
        avg_fill_price DECIMAL(14,4),
        status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
        strategy_id VARCHAR(64),
        position_id VARCHAR(64),
        sync_status VARCHAR(24) NOT NULL DEFAULT 'pending',
        last_synced_at DATETIME,
        raw_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_live_orders_user (user_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS live_positions (
        id VARCHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        broker VARCHAR(32) NOT NULL,
        symbol VARCHAR(32) NOT NULL,
        side VARCHAR(8) NOT NULL,
        quantity INT NOT NULL,
        avg_price DECIMAL(14,4) NOT NULL,
        current_price DECIMAL(14,4),
        unrealized_pnl DECIMAL(18,4) DEFAULT 0,
        status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
        strategy_id VARCHAR(64),
        sync_status VARCHAR(24) NOT NULL DEFAULT 'pending',
        last_synced_at DATETIME,
        opened_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at DATETIME,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_live_positions_user (user_id, status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS broker_error_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        broker VARCHAR(32),
        operation VARCHAR(64) NOT NULL,
        error_code VARCHAR(64),
        error_message TEXT NOT NULL,
        retry_count INT NOT NULL DEFAULT 0,
        request_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_broker_error_logs_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS broker_sync_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        sync_type VARCHAR(24) NOT NULL,
        broker VARCHAR(32) NOT NULL,
        records_synced INT NOT NULL DEFAULT 0,
        status VARCHAR(16) NOT NULL,
        error_message TEXT,
        duration_ms INT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_broker_sync_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS broker_health_snapshots (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        broker VARCHAR(32) NOT NULL,
        status VARCHAR(16) NOT NULL,
        latency_ms INT,
        token_valid TINYINT(1),
        last_order_at DATETIME,
        error_rate_pct DECIMAL(6,2),
        details_json JSON,
        checked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_broker_health_broker (broker, checked_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS live_trading_disclaimers (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL UNIQUE,
        version VARCHAR(16) NOT NULL DEFAULT '1.0',
        accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ip_address VARCHAR(64),
        user_agent TEXT
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS broker_kill_switch_log (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        action VARCHAR(32) NOT NULL,
        reason TEXT,
        actor VARCHAR(100),
        scope VARCHAR(16) NOT NULL DEFAULT 'user',
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_broker_kill_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    migrated = true;
  } catch {
    migrated = true;
  }
}

function enc(value?: string): string | null {
  if (!value) return null;
  try { return encrypt(value); } catch { return value; }
}

function dec(value?: string | null): string | undefined {
  if (!value) return undefined;
  try { return decrypt(value); } catch { return value; }
}

export interface BrokerConnectionRow {
  id: string;
  userId: number;
  broker: BrokerName;
  status: string;
  credentials: BrokerCredentials;
  createdAt: string;
  updatedAt: string;
}

export async function getBrokerConnection(
  userId: number,
  broker: BrokerName,
): Promise<BrokerConnectionRow | null> {
  await ensureBrokerTables();
  const { rows } = await db.query(
    `SELECT a.*, t.access_token_enc, t.refresh_token_enc, t.token_expires_at, t.last_refresh_at
     FROM broker_accounts a
     LEFT JOIN broker_tokens t ON t.account_id = a.id
     WHERE a.user_id = ? AND a.broker = ? LIMIT 1`,
    [userId, broker],
  );
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id: String(r.id),
    userId: Number(r.user_id),
    broker: String(r.broker) as BrokerName,
    status: String(r.status),
    credentials: {
      accessToken: dec(r.access_token_enc as string),
      refreshToken: dec(r.refresh_token_enc as string),
      expiresAt: r.token_expires_at ? String(r.token_expires_at) : undefined,
      brokerUserId: r.broker_user_id ? String(r.broker_user_id) : undefined,
      metadata: r.metadata_json ? JSON.parse(String(r.metadata_json)) : undefined,
    },
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function upsertBrokerConnection(
  userId: number,
  broker: BrokerName,
  credentials: BrokerCredentials,
  status = 'connected',
): Promise<BrokerConnectionRow> {
  await ensureBrokerTables();
  const existing = await getBrokerConnection(userId, broker);
  const accountId = existing?.id ?? `ba_${uuidv4().slice(0, 12)}`;
  const tokenId = `bt_${accountId.slice(3)}`;

  await db.query(
    `INSERT INTO broker_accounts (id, user_id, broker, status, broker_user_id, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       status=VALUES(status), broker_user_id=VALUES(broker_user_id),
       metadata_json=VALUES(metadata_json), updated_at=NOW()`,
    [
      accountId, userId, broker, status,
      credentials.brokerUserId ?? null,
      credentials.metadata ? JSON.stringify(credentials.metadata) : null,
    ],
  );
  await db.query(
    `INSERT INTO broker_tokens
       (id, account_id, user_id, access_token_enc, refresh_token_enc, token_expires_at, last_refresh_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       access_token_enc=VALUES(access_token_enc), refresh_token_enc=VALUES(refresh_token_enc),
       token_expires_at=VALUES(token_expires_at), last_refresh_at=NOW(), updated_at=NOW()`,
    [
      tokenId, accountId, userId,
      enc(credentials.accessToken), enc(credentials.refreshToken),
      credentials.expiresAt ?? null,
    ],
  );
  return (await getBrokerConnection(userId, broker))!;
}

export async function disconnectBrokerAccount(
  userId: number,
  broker: BrokerName,
): Promise<void> {
  await ensureBrokerTables();
  const conn = await getBrokerConnection(userId, broker);
  if (!conn) return;
  await db.query(`UPDATE broker_accounts SET status='disconnected', updated_at=NOW() WHERE id=?`, [conn.id]);
  await db.query(
    `UPDATE broker_tokens SET access_token_enc=NULL, refresh_token_enc=NULL, token_expires_at=NULL, updated_at=NOW()
     WHERE account_id=?`,
    [conn.id],
  );
}

export async function insertBrokerOrder(row: {
  id: string;
  userId: number;
  broker: BrokerName;
  brokerOrderId?: string;
  symbol: string;
  side: string;
  orderType: string;
  quantity: number;
  price?: number;
  status: string;
  strategyId?: string;
}): Promise<void> {
  await ensureBrokerTables();
  await db.query(
    `INSERT INTO live_orders
       (id, user_id, broker, broker_order_id, symbol, side, order_type, quantity, price, status, strategy_id, sync_status, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', NOW())
     ON DUPLICATE KEY UPDATE status=VALUES(status), filled_qty=VALUES(filled_qty),
       avg_fill_price=VALUES(avg_fill_price), sync_status='synced', last_synced_at=NOW()`,
    [
      row.id, row.userId, row.broker, row.brokerOrderId ?? row.id,
      row.symbol, row.side, row.orderType, row.quantity, row.price ?? null,
      row.status, row.strategyId ?? null,
    ],
  );
}

export async function upsertBrokerOrderFromSync(
  userId: number,
  broker: BrokerName,
  order: {
    brokerOrderId: string;
    symbol: string;
    side: string;
    quantity: number;
    filledQty: number;
    price?: number;
    avgFillPrice?: number;
    status: string;
  },
): Promise<void> {
  await ensureBrokerTables();
  const id = `bo_${order.brokerOrderId}`;
  await db.query(
    `INSERT INTO live_orders
       (id, user_id, broker, broker_order_id, symbol, side, order_type, quantity,
        filled_qty, price, avg_fill_price, status, sync_status, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, 'MARKET', ?, ?, ?, ?, ?, 'synced', NOW())
     ON DUPLICATE KEY UPDATE
       filled_qty=VALUES(filled_qty), avg_fill_price=VALUES(avg_fill_price),
       status=VALUES(status), sync_status='synced', last_synced_at=NOW()`,
    [
      id, userId, broker, order.brokerOrderId, order.symbol, order.side,
      order.quantity, order.filledQty, order.price ?? null, order.avgFillPrice ?? null,
      order.status,
    ],
  );
}

export async function listBrokerOrders(userId: number, limit = 100) {
  await ensureBrokerTables();
  const { rows } = await db.query(
    `SELECT * FROM live_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, limit],
  );
  return rows;
}

export async function upsertBrokerPositionFromSync(
  userId: number,
  broker: BrokerName,
  pos: {
    symbol: string;
    side: string;
    quantity: number;
    avgPrice: number;
    currentPrice?: number;
    unrealizedPnl?: number;
    status: string;
  },
): Promise<void> {
  await ensureBrokerTables();
  const id = `bp_${userId}_${pos.symbol}_${pos.side}`;
  await db.query(
    `INSERT INTO live_positions
       (id, user_id, broker, symbol, side, quantity, avg_price, current_price,
        unrealized_pnl, status, sync_status, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synced', NOW())
     ON DUPLICATE KEY UPDATE
       quantity=VALUES(quantity), avg_price=VALUES(avg_price),
       current_price=VALUES(current_price), unrealized_pnl=VALUES(unrealized_pnl),
       status=VALUES(status), sync_status='synced', last_synced_at=NOW()`,
    [
      id, userId, broker, pos.symbol, pos.side, pos.quantity, pos.avgPrice,
      pos.currentPrice ?? null, pos.unrealizedPnl ?? 0, pos.status,
    ],
  );
}

export async function listBrokerPositions(userId: number, status?: string) {
  await ensureBrokerTables();
  if (status) {
    const { rows } = await db.query(
      `SELECT * FROM live_positions WHERE user_id = ? AND status = ? ORDER BY opened_at DESC`,
      [userId, status],
    );
    return rows;
  }
  const { rows } = await db.query(
    `SELECT * FROM live_positions WHERE user_id = ? ORDER BY opened_at DESC LIMIT 200`,
    [userId],
  );
  return rows;
}

export async function logBrokerSync(entry: {
  userId: number;
  syncType: string;
  broker: BrokerName;
  recordsSynced: number;
  status: string;
  errorMessage?: string;
  durationMs?: number;
}): Promise<void> {
  await ensureBrokerTables();
  await db.query(
    `INSERT INTO broker_sync_log (user_id, sync_type, broker, records_synced, status, error_message, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [entry.userId, entry.syncType, entry.broker, entry.recordsSynced, entry.status,
     entry.errorMessage ?? null, entry.durationMs ?? null],
  );
}

export async function logBrokerFailure(entry: {
  userId?: number;
  broker?: string;
  operation: string;
  errorCode?: string;
  errorMessage: string;
  retryCount?: number;
  request?: Record<string, unknown>;
}): Promise<void> {
  await ensureBrokerTables();
  try {
    await db.query(
      `INSERT INTO broker_error_logs (user_id, broker, operation, error_code, error_message, retry_count, request_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.userId ?? null, entry.broker ?? null, entry.operation,
        entry.errorCode ?? null, entry.errorMessage, entry.retryCount ?? 0,
        entry.request ? JSON.stringify(entry.request) : null,
      ],
    );
  } catch { /* best effort */ }
}

export async function saveBrokerHealth(snapshot: BrokerHealthSnapshot): Promise<void> {
  await ensureBrokerTables();
  await db.query(
    `INSERT INTO broker_health_snapshots (broker, status, latency_ms, token_valid, error_rate_pct, details_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      snapshot.broker, snapshot.status, snapshot.latencyMs ?? null,
      snapshot.tokenValid ? 1 : 0, snapshot.errorRatePct ?? null,
      JSON.stringify({ message: snapshot.message, lastOrderAt: snapshot.lastOrderAt }),
    ],
  );
}

export async function getLatestBrokerHealth(broker: BrokerName) {
  await ensureBrokerTables();
  const { rows } = await db.query(
    `SELECT * FROM broker_health_snapshots WHERE broker = ? ORDER BY checked_at DESC LIMIT 1`,
    [broker],
  );
  return rows[0] ?? null;
}

export async function hasAcceptedDisclaimer(userId: number, version: string): Promise<boolean> {
  await ensureBrokerTables();
  const { rows } = await db.query(
    `SELECT id FROM live_trading_disclaimers WHERE user_id = ? AND version = ? LIMIT 1`,
    [userId, version],
  );
  return rows.length > 0;
}

export async function acceptDisclaimer(
  userId: number,
  version: string,
  ip?: string,
  userAgent?: string,
): Promise<void> {
  await ensureBrokerTables();
  await db.query(
    `INSERT INTO live_trading_disclaimers (user_id, version, ip_address, user_agent)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE version=VALUES(version), accepted_at=NOW()`,
    [userId, version, ip ?? null, userAgent ?? null],
  );
}

export async function logBrokerKillSwitch(
  userId: number,
  action: string,
  reason: string,
  actor: string,
  scope = 'user',
): Promise<void> {
  await ensureBrokerTables();
  await db.query(
    `INSERT INTO broker_kill_switch_log (user_id, action, reason, actor, scope) VALUES (?, ?, ?, ?, ?)`,
    [userId, action, reason, actor, scope],
  );
}

export async function countPaperTrades(userId: number): Promise<number> {
  await ensureBrokerTables();
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM trade_logs WHERE user_id = ? AND event_type IN ('FILL','POSITION_CLOSE')`,
      [userId],
    );
    return Number(rows[0]?.cnt ?? 0);
  } catch {
    return 0;
  }
}

export async function countBacktestsPassed(userId: number): Promise<number> {
  try {
    const { rows } = await db.query(
      `SELECT COUNT(*) AS cnt FROM strategy_lab_definitions WHERE backtest_passed = 1`,
    );
    return Number(rows[0]?.cnt ?? 0);
  } catch {
    return 0;
  }
}
