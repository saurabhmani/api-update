// Persist Zerodha Kite OAuth success into broker_connections (+ legacy bridge)

import { upsertBrokerConnection as upsertLegacyBrokerConnection } from '../repository/brokerRepository';
import { upsertBrokerConnectionRecord } from '../connections/repository';
import { resolvePrimaryFlagOnConnect } from '../connections/activeDataSource';
import { completeBrokerAuthTransaction } from '../connections/authTransactions';
import { db } from '@/lib/db';

const KITE_TOKEN_TTL_MS = 20 * 60 * 60 * 1000;

export interface PersistZerodhaConnectionInput {
  userId: number;
  accessToken: string;
  kiteUserId: string;
  userName?: string | null;
  authenticatedAt?: string;
}

/**
 * Save Zerodha credentials after a successful Kite session exchange.
 * Writes broker_connections (primary) and best-effort legacy broker_accounts.
 */
export async function persistZerodhaBrokerConnection(
  input: PersistZerodhaConnectionInput,
): Promise<void> {
  const authenticatedAt = input.authenticatedAt
    ? new Date(input.authenticatedAt)
    : new Date();
  const expiresAt = new Date(authenticatedAt.getTime() + KITE_TOKEN_TTL_MS);

  // Phase 12: first broker → active; never steal another active source.
  const isPrimary = await resolvePrimaryFlagOnConnect(input.userId, 'zerodha');

  await upsertBrokerConnectionRecord({
    userId: input.userId,
    broker: 'zerodha',
    accessToken: input.accessToken,
    brokerAccountId: input.kiteUserId,
    brokerUserName: input.userName ?? null,
    tokenExpiresAt: expiresAt,
    status: 'active',
    isPrimary,
    metadata: {
      source: 'kite_oauth',
      kiteUserId: input.kiteUserId,
      activatedOnConnect: isPrimary,
      providerRejectionConfirmed: false,
      repairedFromExpired: false,
      lastCredentialStatusReason: 'oauth_success',
      lastCredentialStatusAt: new Date().toISOString(),
    },
  });

  // Keep legacy execution layer in sync (broker_accounts / broker_tokens)
  try {
    await upsertLegacyBrokerConnection(
      input.userId,
      'kite',
      {
        accessToken: input.accessToken,
        brokerUserId: input.kiteUserId,
        expiresAt: expiresAt.toISOString(),
        metadata: { displayName: input.userName ?? undefined },
      },
      'connected',
    );
  } catch {
    // Non-fatal — data-source table is the source of truth for routing
  }

  // Mark any pending zerodha auth transactions completed
  try {
    const { rows } = await db.query(
      `SELECT id FROM broker_auth_transactions
       WHERE user_id = ? AND broker = 'zerodha' AND status IN ('pending', 'used')
       ORDER BY created_at DESC LIMIT 1`,
      [input.userId],
    );
    if (rows[0]?.id) {
      await completeBrokerAuthTransaction(String(rows[0].id));
    }
  } catch {
    // optional
  }
}
