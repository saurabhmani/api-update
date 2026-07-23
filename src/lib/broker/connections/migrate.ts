// Migrate legacy broker_accounts / broker_tokens into broker_connections

import { db } from '@/lib/db';
import { decrypt } from '@/lib/encryption';
import { ensureBrokerTables } from '../repository/brokerRepository';
import {
  ensureBrokerConnectionTables,
  getBrokerConnectionByUserAndBroker,
  upsertBrokerConnectionRecord,
} from './repository';
import { normalizeDataSourceBroker } from './types';

let migratedUsers = new Set<number>();

/**
 * One-time-per-process lazy migration for a single user.
 * Copies connected kite/zerodha (and shoonya if present) rows from the
 * legacy broker_accounts + broker_tokens tables into broker_connections.
 * Does not delete legacy columns/rows.
 */
export async function migrateLegacyBrokerDataForUser(userId: number): Promise<number> {
  if (migratedUsers.has(userId)) return 0;

  await ensureBrokerTables();
  await ensureBrokerConnectionTables();

  let migrated = 0;

  try {
    const { rows } = await db.query(
      `SELECT a.user_id, a.broker, a.status, a.broker_user_id, a.metadata_json,
              t.access_token_enc, t.refresh_token_enc, t.token_expires_at
       FROM broker_accounts a
       LEFT JOIN broker_tokens t ON t.account_id = a.id
       WHERE a.user_id = ?
         AND a.status IN ('connected', 'active')
         AND t.access_token_enc IS NOT NULL
         AND t.access_token_enc <> ''`,
      [userId],
    );

    for (const row of rows as Record<string, unknown>[]) {
      const broker = normalizeDataSourceBroker(String(row.broker ?? ''));
      if (!broker) continue;

      const existing = await getBrokerConnectionByUserAndBroker(userId, broker);
      if (existing?.status === 'active' && existing.accessTokenEncrypted) {
        continue;
      }

      const encToken = String(row.access_token_enc ?? '');
      if (!encToken) continue;

      let accessToken: string;
      try {
        accessToken = decrypt(encToken);
      } catch {
        accessToken = encToken;
      }
      if (!accessToken) continue;

      let refreshToken: string | null = null;
      if (row.refresh_token_enc) {
        try {
          refreshToken = decrypt(String(row.refresh_token_enc));
        } catch {
          refreshToken = String(row.refresh_token_enc);
        }
      }

      await upsertBrokerConnectionRecord({
        userId,
        broker,
        accessToken,
        refreshToken,
        brokerAccountId: row.broker_user_id ? String(row.broker_user_id) : null,
        tokenExpiresAt: row.token_expires_at ? String(row.token_expires_at) : null,
        status: 'active',
        isPrimary: true,
        metadata: {
          source: 'legacy_broker_accounts',
          migratedAt: new Date().toISOString(),
        },
      });
      migrated += 1;
    }
  } catch {
    // Legacy tables may not exist yet — ignore
  }

  migratedUsers.add(userId);
  return migrated;
}

/**
 * Bulk migration entry point for operators / migrate scripts.
 * Returns number of users processed with at least one migrated row.
 */
export async function migrateAllLegacyBrokerConnections(): Promise<{
  usersProcessed: number;
  connectionsMigrated: number;
}> {
  await ensureBrokerTables();
  await ensureBrokerConnectionTables();

  let usersProcessed = 0;
  let connectionsMigrated = 0;

  try {
    const { rows } = await db.query(
      `SELECT DISTINCT user_id FROM broker_accounts
       WHERE status IN ('connected', 'active')`,
    );

    for (const row of rows as Record<string, unknown>[]) {
      const userId = Number(row.user_id);
      if (!userId) continue;
      migratedUsers.delete(userId);
      const count = await migrateLegacyBrokerDataForUser(userId);
      if (count > 0) {
        usersProcessed += 1;
        connectionsMigrated += count;
      }
    }
  } catch {
    // no-op
  }

  return { usersProcessed, connectionsMigrated };
}

/** Test helper — clear the per-process migration cache. */
export function resetLegacyMigrationCache(): void {
  migratedUsers = new Set();
}
