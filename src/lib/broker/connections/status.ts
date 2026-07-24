// Safe broker connection status + post-login routing helpers

import { getActiveKiteSession } from '@/lib/kite/active-session-store';
import {
  getPrimaryActiveBrokerConnection,
  listBrokerConnectionsForUser,
  markBrokerConnectionStatus,
  upsertBrokerConnectionRecord,
} from './repository';
import { migrateLegacyBrokerDataForUser } from './migrate';
import { isBrokerTokenExpired } from './expiry';
import {
  BROKER_DISPLAY_NAMES,
  type BrokerConnectionRecord,
  type DataSourceBroker,
  type SafeBrokerStatus,
} from './types';

function isExpired(expiresAt: string | null): boolean {
  return isBrokerTokenExpired(expiresAt);
}

function maskAccountId(accountId: string | null): string | null {
  if (!accountId) return null;
  if (accountId.length <= 4) return '****';
  return `${accountId.slice(0, 2)}****${accountId.slice(-2)}`;
}

function toSafeStatus(conn: BrokerConnectionRecord | null): SafeBrokerStatus {
  if (!conn) {
    return {
      connected: false,
      broker: null,
      status: 'none',
      accountId: null,
      userName: null,
      expiresAt: null,
      displayName: null,
    };
  }

  const expired = isExpired(conn.tokenExpiresAt);
  const status = expired && conn.status === 'active' ? 'expired' : conn.status;
  const connected = status === 'active' && !expired;

  return {
    connected,
    broker: conn.broker,
    status,
    accountId: maskAccountId(conn.brokerAccountId),
    userName: conn.brokerUserName,
    expiresAt: conn.tokenExpiresAt,
    displayName: BROKER_DISPLAY_NAMES[conn.broker],
  };
}

/**
 * Resolve the user's active data-source connection.
 * Lazily migrates legacy broker_accounts / Redis Kite sessions.
 */
export async function resolveActiveBrokerConnection(
  userId: number,
): Promise<BrokerConnectionRecord | null> {
  await migrateLegacyBrokerDataForUser(userId);

  let conn = await getPrimaryActiveBrokerConnection(userId);
  if (conn && isExpired(conn.tokenExpiresAt)) {
    await markBrokerConnectionStatus(userId, conn.broker, 'expired');
    return null;
  }
  if (conn) return conn;

  // Soft bridge: Redis active Kite session for this Quant user
  try {
    const kite = await getActiveKiteSession();
    if (kite && kite.quantorusUserId === String(userId) && kite.accessToken) {
      const expires = new Date(kite.authenticatedAt);
      expires.setHours(expires.getHours() + 20);
      conn = await upsertBrokerConnectionRecord({
        userId,
        broker: 'zerodha',
        accessToken: kite.accessToken,
        brokerAccountId: kite.kiteUserId,
        tokenExpiresAt: expires,
        status: 'active',
        isPrimary: true,
        metadata: { source: 'redis_active_session' },
      });
      return conn;
    }
  } catch {
    // Redis optional
  }

  return null;
}

export async function getSafeBrokerStatus(userId: number): Promise<SafeBrokerStatus> {
  const conn = await resolveActiveBrokerConnection(userId);
  return toSafeStatus(conn);
}

export async function hasActiveBrokerConnection(userId: number): Promise<boolean> {
  const status = await getSafeBrokerStatus(userId);
  return status.connected;
}

export type PostLoginDestination =
  | { path: '/dashboard' }
  | { path: '/data-source'; reason?: 'session_expired' };

export async function resolvePostLoginDestination(
  userId: number,
): Promise<PostLoginDestination> {
  try {
    const connections = await listBrokerConnectionsForUser(userId);
    const expiredPrimary = connections.find(
      (c) => c.status === 'expired' || (c.status === 'active' && isExpired(c.tokenExpiresAt)),
    );

    const active = await resolveActiveBrokerConnection(userId);
    if (active) return { path: '/dashboard' };

    if (expiredPrimary) {
      return { path: '/data-source', reason: 'session_expired' };
    }

    return { path: '/data-source' };
  } catch {
    // Prefer data-source on unexpected storage failures after login so we
    // do not bounce authenticated users into a dashboard that immediately
    // redirects again when the DB recovers empty.
    return { path: '/data-source' };
  }
}

export function brokerDisplayName(broker: DataSourceBroker): string {
  return BROKER_DISPLAY_NAMES[broker];
}
