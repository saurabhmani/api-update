// Pending broker OAuth transactions — short-lived, single-use

import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { db } from '@/lib/db';
import { ensureBrokerConnectionTables } from './repository';
import type {
  BrokerAuthTransaction,
  BrokerAuthTransactionStatus,
  DataSourceBroker,
} from './types';

const DEFAULT_TTL_MS = 8 * 60 * 1000; // 8 minutes

function hashState(state: string): string {
  return crypto.createHash('sha256').update(state).digest('hex');
}

/** Format a Date as a MySQL DATETIME string in UTC (no timezone suffix). */
export function toMysqlUtcDatetime(date: Date): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Parse a MySQL DATETIME that we wrote via toMysqlUtcDatetime (UTC wall clock).
 * Without a trailing Z, `new Date('YYYY-MM-DD HH:mm:ss')` is treated as local
 * time and immediately "expires" transactions in IST / other positive offsets.
 */
export function parseMysqlUtcDatetime(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return Number.NaN;
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(trimmed)) {
    return new Date(trimmed).getTime();
  }
  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  return new Date(`${normalized}Z`).getTime();
}

function rowToTx(r: Record<string, unknown>): BrokerAuthTransaction {
  return {
    id: String(r.id),
    userId: Number(r.user_id),
    broker: String(r.broker) as DataSourceBroker,
    stateHash: r.state_hash ? String(r.state_hash) : null,
    status: String(r.status) as BrokerAuthTransactionStatus,
    expiresAt: String(r.expires_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
    createdAt: String(r.created_at),
  };
}

export function createBrokerOAuthState(): string {
  return crypto.randomBytes(32).toString('hex');
}

export async function createBrokerAuthTransaction(opts: {
  userId: number;
  broker: DataSourceBroker;
  state?: string | null;
  ttlMs?: number;
}): Promise<{ transaction: BrokerAuthTransaction; state: string | null }> {
  await ensureBrokerConnectionTables();

  const id = `bat_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
  const state = opts.state === undefined ? createBrokerOAuthState() : opts.state;
  const stateHash = state ? hashState(state) : null;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const expiresSql = toMysqlUtcDatetime(new Date(Date.now() + ttl));

  // Invalidate any other pending transactions for this user+broker
  await db.query(
    `UPDATE broker_auth_transactions
     SET status = 'expired'
     WHERE user_id = ? AND broker = ? AND status = 'pending'`,
    [opts.userId, opts.broker],
  );

  await db.query(
    `INSERT INTO broker_auth_transactions
       (id, user_id, broker, state_hash, status, expires_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    [id, opts.userId, opts.broker, stateHash, expiresSql],
  );

  const { rows } = await db.query(
    `SELECT * FROM broker_auth_transactions WHERE id = ? LIMIT 1`,
    [id],
  );

  return {
    transaction: rowToTx(rows[0] as Record<string, unknown>),
    state,
  };
}

/**
 * Atomically claim a pending transaction for exchange.
 * Does NOT mark completed — call completeBrokerAuthTransaction after
 * token persistence succeeds. On exchange failure call failBrokerAuthTransaction.
 */
export async function consumeBrokerAuthTransaction(opts: {
  userId: number;
  broker: DataSourceBroker;
  state?: string | null;
}): Promise<BrokerAuthTransaction | null> {
  await ensureBrokerConnectionTables();

  let rows: Record<string, unknown>[];

  if (opts.state) {
    const stateHash = hashState(opts.state);
    const result = await db.query(
      `SELECT * FROM broker_auth_transactions
       WHERE user_id = ? AND broker = ? AND state_hash = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [opts.userId, opts.broker, stateHash],
    );
    rows = result.rows as Record<string, unknown>[];

    // Shoonya (and similar) may echo an unrelated state while our pending row
    // was created with state_hash NULL — fall back to user+broker pending.
    if (!rows.length) {
      const fallback = await db.query(
        `SELECT * FROM broker_auth_transactions
         WHERE user_id = ? AND broker = ? AND status = 'pending' AND state_hash IS NULL
         ORDER BY created_at DESC LIMIT 1`,
        [opts.userId, opts.broker],
      );
      rows = fallback.rows as Record<string, unknown>[];
    }
  } else {
    const result = await db.query(
      `SELECT * FROM broker_auth_transactions
       WHERE user_id = ? AND broker = ? AND status = 'pending'
       ORDER BY created_at DESC LIMIT 1`,
      [opts.userId, opts.broker],
    );
    rows = result.rows as Record<string, unknown>[];
  }

  if (!rows.length) return null;

  const tx = rowToTx(rows[0]);
  const expiresAt = parseMysqlUtcDatetime(tx.expiresAt);
  if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    await db.query(
      `UPDATE broker_auth_transactions SET status = 'expired' WHERE id = ? AND status = 'pending'`,
      [tx.id],
    );
    return null;
  }

  // Claim without completing — prevents duplicate exchangers.
  const updateResult = await db.query(
    `UPDATE broker_auth_transactions
     SET status = 'used'
     WHERE id = ? AND status = 'pending' AND expires_at > UTC_TIMESTAMP()`,
    [tx.id],
  );

  const affected = Number(updateResult.affectedRows ?? 0);
  if (affected === 0) return null;

  return { ...tx, status: 'used' };
}

/**
 * Mark completed only after encrypted token persistence succeeds.
 */
export async function completeBrokerAuthTransaction(id: string): Promise<void> {
  await ensureBrokerConnectionTables();
  await db.query(
    `UPDATE broker_auth_transactions
     SET status = 'completed', completed_at = UTC_TIMESTAMP()
     WHERE id = ? AND status IN ('used', 'pending')`,
    [id],
  );
}

export async function failBrokerAuthTransaction(id: string): Promise<void> {
  await ensureBrokerConnectionTables();
  await db.query(
    `UPDATE broker_auth_transactions
     SET status = 'failed', completed_at = UTC_TIMESTAMP()
     WHERE id = ? AND status IN ('used', 'pending')`,
    [id],
  );
}

/** Find a recently completed transaction (for idempotent duplicate callbacks). */
export async function findRecentCompletedAuthTransaction(opts: {
  userId: number;
  broker: DataSourceBroker;
  withinMs?: number;
}): Promise<BrokerAuthTransaction | null> {
  await ensureBrokerConnectionTables();
  const withinMs = opts.withinMs ?? 5 * 60 * 1000;
  const since = toMysqlUtcDatetime(new Date(Date.now() - withinMs));
  const { rows } = await db.query(
    `SELECT * FROM broker_auth_transactions
     WHERE user_id = ? AND broker = ? AND status = 'completed'
       AND completed_at >= ?
     ORDER BY completed_at DESC LIMIT 1`,
    [opts.userId, opts.broker, since],
  );
  if (!rows.length) return null;
  return rowToTx(rows[0] as Record<string, unknown>);
}
