// broker_connections — MySQL persistence for data-source brokers

import { v4 as uuidv4 } from 'uuid';
import { db } from '@/lib/db';
import { encryptBrokerCredential, decryptBrokerCredential } from './encryption';
import { toMysqlUtcDateTime } from './expiry';
import type {
  BrokerConnectionRecord,
  BrokerConnectionStatus,
  DataSourceBroker,
} from './types';

let ensured = false;

export async function ensureBrokerConnectionTables(): Promise<void> {
  if (ensured) return;
  try {
    await db.query(`
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
        INDEX idx_broker_connections_expires (token_expires_at),
        CONSTRAINT fk_broker_connections_user
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
  } catch (err) {
    // FK may fail if users table is missing during early boot, or if the
    // table already exists without the FK — fall back to schema without FK.
    const msg = err instanceof Error ? err.message : String(err);
    if (/foreign key|errno: 121|Duplicate|already exists/i.test(msg)) {
      try {
        await db.query(`
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
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
      } catch {
        // Leave ensured=false so the next call retries.
        return;
      }
    } else {
      return;
    }
  }

  try {
    await db.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    ensured = true;
  } catch {
    // Do not cache failure — concurrent boots / transient MySQL errors retry.
  }
}

function rowToRecord(r: Record<string, unknown>): BrokerConnectionRecord {
  let metadata: Record<string, unknown> | null = null;
  if (r.metadata != null) {
    try {
      metadata = typeof r.metadata === 'string'
        ? JSON.parse(r.metadata)
        : (r.metadata as Record<string, unknown>);
    } catch {
      metadata = null;
    }
  }

  return {
    id: String(r.id),
    userId: Number(r.user_id),
    broker: String(r.broker) as DataSourceBroker,
    brokerAccountId: r.broker_account_id ? String(r.broker_account_id) : null,
    brokerUserName: r.broker_user_name ? String(r.broker_user_name) : null,
    accessTokenEncrypted: r.access_token_encrypted ? String(r.access_token_encrypted) : null,
    refreshTokenEncrypted: r.refresh_token_encrypted ? String(r.refresh_token_encrypted) : null,
    tokenExpiresAt: r.token_expires_at ? String(r.token_expires_at) : null,
    lastAuthenticatedAt: r.last_authenticated_at ? String(r.last_authenticated_at) : null,
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
    status: String(r.status) as BrokerConnectionStatus,
    isPrimary: Boolean(Number(r.is_primary)),
    metadata,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export async function getBrokerConnectionByUserAndBroker(
  userId: number,
  broker: DataSourceBroker,
): Promise<BrokerConnectionRecord | null> {
  await ensureBrokerConnectionTables();
  const { rows } = await db.query(
    `SELECT * FROM broker_connections WHERE user_id = ? AND broker = ? LIMIT 1`,
    [userId, broker],
  );
  if (!rows.length) return null;
  return rowToRecord(rows[0] as Record<string, unknown>);
}

export async function listBrokerConnectionsForUser(
  userId: number,
): Promise<BrokerConnectionRecord[]> {
  await ensureBrokerConnectionTables();
  const { rows } = await db.query(
    `SELECT * FROM broker_connections WHERE user_id = ? ORDER BY is_primary DESC, updated_at DESC`,
    [userId],
  );
  return rows.map((r) => rowToRecord(r as Record<string, unknown>));
}

export async function getPrimaryActiveBrokerConnection(
  userId: number,
): Promise<BrokerConnectionRecord | null> {
  await ensureBrokerConnectionTables();
  const { rows } = await db.query(
    `SELECT * FROM broker_connections
     WHERE user_id = ? AND status = 'active'
     ORDER BY is_primary DESC, last_authenticated_at DESC
     LIMIT 1`,
    [userId],
  );
  if (!rows.length) return null;
  return rowToRecord(rows[0] as Record<string, unknown>);
}

export interface UpsertBrokerConnectionInput {
  userId: number;
  broker: DataSourceBroker;
  accessToken: string;
  refreshToken?: string | null;
  brokerAccountId?: string | null;
  brokerUserName?: string | null;
  tokenExpiresAt?: Date | string | null;
  status?: BrokerConnectionStatus;
  isPrimary?: boolean;
  metadata?: Record<string, unknown> | null;
}

export async function upsertBrokerConnectionRecord(
  input: UpsertBrokerConnectionInput,
): Promise<BrokerConnectionRecord> {
  await ensureBrokerConnectionTables();

  const existing = await getBrokerConnectionByUserAndBroker(input.userId, input.broker);
  const id = existing?.id ?? `bc_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const status = input.status ?? 'active';
  const isPrimary = input.isPrimary ?? true;
  const accessEnc = encryptBrokerCredential(input.accessToken);
  const refreshEnc = input.refreshToken
    ? encryptBrokerCredential(input.refreshToken)
    : null;
  let expiresAt: string | null = null;
  if (input.tokenExpiresAt instanceof Date) {
    expiresAt = Number.isNaN(input.tokenExpiresAt.getTime())
      ? null
      : toMysqlUtcDateTime(input.tokenExpiresAt);
  } else if (typeof input.tokenExpiresAt === 'string' && input.tokenExpiresAt.trim()) {
    const d = new Date(input.tokenExpiresAt.includes('T')
      ? input.tokenExpiresAt
      : `${input.tokenExpiresAt.trim().replace(' ', 'T')}Z`);
    expiresAt = Number.isNaN(d.getTime()) ? null : toMysqlUtcDateTime(d);
  }
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;

  if (isPrimary) {
    await db.query(
      `UPDATE broker_connections SET is_primary = 0, updated_at = NOW()
       WHERE user_id = ? AND id <> ?`,
      [input.userId, id],
    );
  }

  await db.query(
    `INSERT INTO broker_connections (
       id, user_id, broker, broker_account_id, broker_user_name,
       access_token_encrypted, refresh_token_encrypted, token_expires_at,
       last_authenticated_at, status, is_primary, metadata
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       broker_account_id = VALUES(broker_account_id),
       broker_user_name = VALUES(broker_user_name),
       access_token_encrypted = VALUES(access_token_encrypted),
       refresh_token_encrypted = COALESCE(VALUES(refresh_token_encrypted), refresh_token_encrypted),
       token_expires_at = VALUES(token_expires_at),
       last_authenticated_at = NOW(),
       status = VALUES(status),
       is_primary = VALUES(is_primary),
       metadata = COALESCE(VALUES(metadata), metadata),
       updated_at = NOW()`,
    [
      id,
      input.userId,
      input.broker,
      input.brokerAccountId ?? null,
      input.brokerUserName ?? null,
      accessEnc,
      refreshEnc,
      expiresAt,
      status,
      isPrimary ? 1 : 0,
      metadataJson,
    ],
  );

  return (await getBrokerConnectionByUserAndBroker(input.userId, input.broker))!;
}

export async function markBrokerConnectionStatus(
  userId: number,
  broker: DataSourceBroker,
  status: BrokerConnectionStatus,
  clearTokens = false,
): Promise<void> {
  await ensureBrokerConnectionTables();
  if (clearTokens) {
    await db.query(
      `UPDATE broker_connections
       SET status = ?, access_token_encrypted = NULL, refresh_token_encrypted = NULL,
           is_primary = 0, updated_at = NOW()
       WHERE user_id = ? AND broker = ?`,
      [status, userId, broker],
    );
    return;
  }
  await db.query(
    `UPDATE broker_connections SET status = ?, updated_at = NOW()
     WHERE user_id = ? AND broker = ?`,
    [status, userId, broker],
  );
}

export async function touchBrokerConnectionUsed(
  userId: number,
  broker: DataSourceBroker,
): Promise<void> {
  await ensureBrokerConnectionTables();
  await db.query(
    `UPDATE broker_connections SET last_used_at = NOW(), updated_at = NOW()
     WHERE user_id = ? AND broker = ?`,
    [userId, broker],
  );
}

/**
 * Decrypt access token for a connection owned by userId only.
 * Returns null if missing / wrong user / no token.
 */
export async function getDecryptedAccessTokenForUser(
  userId: number,
  broker: DataSourceBroker,
): Promise<string | null> {
  const conn = await getBrokerConnectionByUserAndBroker(userId, broker);
  if (!conn || conn.userId !== userId || !conn.accessTokenEncrypted) return null;
  try {
    return decryptBrokerCredential(conn.accessTokenEncrypted);
  } catch {
    return null;
  }
}
