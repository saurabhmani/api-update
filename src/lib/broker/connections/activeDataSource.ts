/**
 * Per-user active data-source resolution.
 *
 * Reuses `broker_connections.is_primary` as the explicit
 * `is_active_data_source` preference. Never reads MARKET_DATA_PROVIDER.
 *
 * Rules:
 *  - Exactly one usable connection → that broker (auto-promote primary if needed)
 *  - Multiple usable + one is_primary → that broker
 *  - Multiple usable + no primary → needsSelection
 *  - Remaining connections flagged pendingActiveSelection after
 *    disconnecting the active source → needsSelection (no silent switch)
 */

import { getActiveKiteSession } from '@/lib/kite/active-session-store';
import { getBrokerMarketDataProvider } from '@/lib/marketData/brokerProvider';
import type { BrokerMarketDataProvider } from '@/lib/marketData/brokerProvider';
import { isBrokerTokenExpired } from './expiry';
import { migrateLegacyBrokerDataForUser } from './migrate';
import {
  listBrokerConnectionsForUser,
  markBrokerConnectionStatus,
  markRemainingConnectionsNeedSelection,
  mergeBrokerConnectionMetadata,
  setPrimaryDataSourceBroker,
  upsertBrokerConnectionRecord,
} from './repository';
import {
  BROKER_DISPLAY_NAMES,
  type BrokerConnectionRecord,
  type DataSourceBroker,
  type SafeBrokerConnectionSummary,
  type SafeBrokerStatus,
} from './types';

export type ActiveDataSourceReason =
  | 'primary'
  | 'sole_connection'
  | 'needs_selection'
  | 'none'
  | 'expired';

export interface UserActiveDataSource {
  userId: number;
  /** Null when none / needsSelection */
  provider: DataSourceBroker | null;
  connection: BrokerConnectionRecord | null;
  connectionId: string | null;
  isConnected: boolean;
  isActiveDataSource: boolean;
  needsSelection: boolean;
  reason: ActiveDataSourceReason;
  /** Usable (active, non-expired, token present) connections */
  connectedProviders: DataSourceBroker[];
  updatedAt: string | null;
}

function isUsable(conn: BrokerConnectionRecord): boolean {
  if (conn.status !== 'active') return false;
  if (!conn.accessTokenEncrypted) return false;
  if (isBrokerTokenExpired(conn.tokenExpiresAt)) return false;
  return true;
}

function pendingSelection(conn: BrokerConnectionRecord): boolean {
  return conn.metadata?.pendingActiveSelection === true;
}

function maskAccountId(accountId: string | null): string | null {
  if (!accountId) return null;
  if (accountId.length <= 4) return '****';
  return `${accountId.slice(0, 2)}****${accountId.slice(-2)}`;
}

function toSummary(
  conn: BrokerConnectionRecord,
  activeProvider: DataSourceBroker | null,
): SafeBrokerConnectionSummary {
  const expired = isBrokerTokenExpired(conn.tokenExpiresAt);
  const status = expired && conn.status === 'active' ? 'expired' : conn.status;
  const connected = status === 'active' && !expired && !!conn.accessTokenEncrypted;
  return {
    broker: conn.broker,
    status,
    connected,
    isActiveDataSource: activeProvider === conn.broker,
    accountId: maskAccountId(conn.brokerAccountId),
    userName: conn.brokerUserName,
    expiresAt: conn.tokenExpiresAt,
    displayName: BROKER_DISPLAY_NAMES[conn.broker],
    updatedAt: conn.updatedAt,
  };
}

async function maybeBridgeRedisKite(userId: number): Promise<void> {
  try {
    const kite = await getActiveKiteSession();
    if (kite && kite.quantorusUserId === String(userId) && kite.accessToken) {
      const existing = (await listBrokerConnectionsForUser(userId)).find(
        (c) => c.broker === 'zerodha' && c.status === 'active',
      );
      if (existing) return;
      const expires = new Date(kite.authenticatedAt);
      expires.setHours(expires.getHours() + 20);
      await upsertBrokerConnectionRecord({
        userId,
        broker: 'zerodha',
        accessToken: kite.accessToken,
        brokerAccountId: kite.kiteUserId,
        tokenExpiresAt: expires,
        status: 'active',
        isPrimary: true,
        metadata: { source: 'redis_active_session' },
      });
    }
  } catch {
    // Redis optional
  }
}

/**
 * Resolve the authenticated user's active data-source broker.
 * Never falls back to process.env / MARKET_DATA_PROVIDER.
 */
export async function getUserActiveDataSource(
  userId: number,
): Promise<UserActiveDataSource> {
  await migrateLegacyBrokerDataForUser(userId);
  await maybeBridgeRedisKite(userId);

  const all = await listBrokerConnectionsForUser(userId);

  // Expire stale actives in place
  for (const conn of all) {
    if (conn.status === 'active' && isBrokerTokenExpired(conn.tokenExpiresAt)) {
      await markBrokerConnectionStatus(userId, conn.broker, 'expired');
      conn.status = 'expired';
    }
  }

  const usable = all.filter(isUsable);
  const connectedProviders = usable.map((c) => c.broker);

  const empty = (reason: ActiveDataSourceReason): UserActiveDataSource => ({
    userId,
    provider: null,
    connection: null,
    connectionId: null,
    isConnected: false,
    isActiveDataSource: false,
    needsSelection: reason === 'needs_selection',
    reason,
    connectedProviders,
    updatedAt: null,
  });

  if (usable.length === 0) {
    const hadExpired = all.some(
      (c) =>
        c.status === 'expired'
        || (c.status === 'active' && isBrokerTokenExpired(c.tokenExpiresAt)),
    );
    return empty(hadExpired ? 'expired' : 'none');
  }

  const primaries = usable.filter((c) => c.isPrimary);
  if (primaries.length >= 1) {
    const chosen = primaries[0]!;
    // Repair duplicate primaries
    if (primaries.length > 1) {
      await setPrimaryDataSourceBroker(userId, chosen.broker);
    }
    return {
      userId,
      provider: chosen.broker,
      connection: chosen,
      connectionId: chosen.id,
      isConnected: true,
      isActiveDataSource: true,
      needsSelection: false,
      reason: 'primary',
      connectedProviders,
      updatedAt: chosen.updatedAt,
    };
  }

  // No explicit primary. Pending selection after disconnect of active source.
  if (usable.some(pendingSelection) || usable.length > 1) {
    return {
      ...empty('needs_selection'),
      isConnected: true,
      needsSelection: true,
      connectedProviders,
    };
  }

  // Exactly one usable, no pending flag → sole connection (auto-promote).
  const sole = usable[0]!;
  const promoted = await setPrimaryDataSourceBroker(userId, sole.broker);
  const connection = promoted ?? sole;
  return {
    userId,
    provider: connection.broker,
    connection,
    connectionId: connection.id,
    isConnected: true,
    isActiveDataSource: true,
    needsSelection: false,
    reason: 'sole_connection',
    connectedProviders,
    updatedAt: connection.updatedAt,
  };
}

/**
 * Decide whether a newly connected / reconnected broker should become
 * the active data source (`is_primary`).
 *
 * Rules (Phase 12):
 *  - First usable broker for this user → active
 *  - Reconnecting the broker that is already primary → stay active
 *  - Another broker is already active → keep that selection (return false)
 *  - Multiple others without a primary → do not auto-steal (return false)
 */
export async function resolvePrimaryFlagOnConnect(
  userId: number,
  broker: DataSourceBroker,
): Promise<boolean> {
  const all = await listBrokerConnectionsForUser(userId);
  const existing = all.find((c) => c.broker === broker);
  const otherUsable = all.filter((c) => c.broker !== broker && isUsable(c));

  // Reconnecting the already-active source must not demote it.
  if (existing?.isPrimary) return true;

  // Another connected broker is already the explicit active source.
  if (otherUsable.some((c) => c.isPrimary)) return false;

  // First (or sole remaining) usable broker after this connect.
  if (otherUsable.length === 0) return true;

  // Others exist but none is primary — require explicit user switch.
  return false;
}

/**
 * Persist an explicit active data-source preference (soft switch).
 * Target must already be connected/usable.
 */
export async function setUserActiveDataSource(
  userId: number,
  broker: DataSourceBroker,
): Promise<UserActiveDataSource> {
  const all = await listBrokerConnectionsForUser(userId);
  const target = all.find((c) => c.broker === broker);
  if (!target || !isUsable(target)) {
    throw new ActiveDataSourceError(
      'not_connected',
      `${broker} is not connected — connect it before setting as active data source`,
    );
  }

  await setPrimaryDataSourceBroker(userId, broker);
  // Ensure pending flags cleared on all rows
  for (const row of all) {
    if (row.metadata?.pendingActiveSelection) {
      await mergeBrokerConnectionMetadata(userId, row.broker, {
        pendingActiveSelection: false,
      });
    }
  }

  return getUserActiveDataSource(userId);
}

/**
 * Disconnect handling: clear tokens on the broker, and if it was the
 * active data source while others remain connected, flag them so we
 * do not silently promote another provider.
 */
export async function disconnectDataSourceBroker(
  userId: number,
  broker: DataSourceBroker,
): Promise<{
  disconnected: DataSourceBroker;
  needsSelection: boolean;
  remainingConnected: DataSourceBroker[];
  redirectTo: string;
}> {
  const before = await getUserActiveDataSource(userId);
  const wasActive = before.provider === broker;

  await markBrokerConnectionStatus(userId, broker, 'disconnected', true);

  let needsSelection = false;
  let remaining: DataSourceBroker[] = [];

  if (wasActive) {
    const marked = await markRemainingConnectionsNeedSelection(userId);
    needsSelection = marked > 0;
    const after = await listBrokerConnectionsForUser(userId);
    remaining = after.filter(isUsable).map((c) => c.broker);
  } else {
    const after = await getUserActiveDataSource(userId);
    remaining = after.connectedProviders;
    needsSelection = after.needsSelection;
  }

  const redirectTo = needsSelection
    ? '/data-source?reason=select_data_source'
    : remaining.length === 0
      ? '/data-source'
      : '/data-source';

  return {
    disconnected: broker,
    needsSelection,
    remainingConnected: remaining,
    redirectTo,
  };
}

export async function getSafeBrokerStatus(userId: number): Promise<SafeBrokerStatus> {
  const active = await getUserActiveDataSource(userId);
  const all = await listBrokerConnectionsForUser(userId);
  const connections = all.map((c) => toSummary(c, active.provider));

  if (active.needsSelection) {
    return {
      connected: active.connectedProviders.length > 0,
      broker: null,
      status: 'none',
      accountId: null,
      userName: null,
      expiresAt: null,
      displayName: null,
      needsSelection: true,
      connections,
      activeDataSource: null,
    };
  }

  if (!active.connection || !active.provider) {
    return {
      connected: false,
      broker: null,
      status: active.reason === 'expired' ? 'expired' : 'none',
      accountId: null,
      userName: null,
      expiresAt: null,
      displayName: null,
      needsSelection: false,
      connections,
      activeDataSource: null,
    };
  }

  const conn = active.connection;
  return {
    connected: true,
    broker: active.provider,
    status: conn.status,
    accountId: maskAccountId(conn.brokerAccountId),
    userName: conn.brokerUserName,
    expiresAt: conn.tokenExpiresAt,
    displayName: BROKER_DISPLAY_NAMES[active.provider],
    needsSelection: false,
    connections,
    activeDataSource: active.provider,
  };
}

export async function hasActiveBrokerConnection(userId: number): Promise<boolean> {
  const active = await getUserActiveDataSource(userId);
  return Boolean(active.provider && active.isConnected && !active.needsSelection);
}

/**
 * Broker-scoped market-data provider for this user.
 * Throws if the user has no explicit active data source.
 */
export async function getUserBrokerMarketDataProvider(
  userId: number,
): Promise<{ active: UserActiveDataSource; provider: BrokerMarketDataProvider }> {
  const active = await getUserActiveDataSource(userId);
  if (active.needsSelection) {
    throw new ActiveDataSourceError(
      'needs_selection',
      'Select an active data source before requesting market data',
    );
  }
  if (!active.provider) {
    throw new ActiveDataSourceError(
      'none',
      'No active data source — connect a broker on /data-source',
    );
  }
  return {
    active,
    provider: getBrokerMarketDataProvider(active.provider),
  };
}

export type ActiveDataSourceErrorCode = 'none' | 'needs_selection' | 'not_connected' | 'unauthorized';

export class ActiveDataSourceError extends Error {
  readonly code: ActiveDataSourceErrorCode;

  constructor(code: ActiveDataSourceErrorCode, message: string) {
    super(message);
    this.name = 'ActiveDataSourceError';
    this.code = code;
  }
}
