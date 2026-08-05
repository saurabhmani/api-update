/**
 * Per-user active broker connection status (optional for market data).
 *
 * Market data uses the IndianAPI warehouse — product use does not require
 * Zerodha/Shoonya. Broker connections remain for paper/live trading UX.
 *
 * Reuses `broker_connections.is_primary` as the explicit
 * `is_active_data_source` preference. Never reads MARKET_DATA_PROVIDER.
 */

import { isBrokerTokenExpired } from './expiry';
import {
  effectiveCredentialStatus,
  expireCredentialIfPastExpiry,
  isCredentialUsable,
  repairMisclassifiedExpiredCredential,
  setCredentialStatus,
} from './credentialStatus';
import { migrateLegacyBrokerDataForUser } from './migrate';
import {
  listBrokerConnectionsForUser,
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
  return isCredentialUsable(conn);
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
  const status = effectiveCredentialStatus(conn);
  const connected = isCredentialUsable({ ...conn, status: conn.status });
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

async function maybeBridgeRedisKite(_userId: number): Promise<void> {
  // Kite Redis session bridge removed — IndianAPI-only market data.
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

  // Repair misclassified expired rows (future token_expires_at) → reauth_required.
  // Expire only when token time has actually passed.
  for (let i = 0; i < all.length; i++) {
    let conn = all[i]!;
    if (conn.status === 'expired' && !isBrokerTokenExpired(conn.tokenExpiresAt)) {
      conn = await repairMisclassifiedExpiredCredential(conn);
      all[i] = conn;
      continue;
    }
    if (conn.status === 'active' && isBrokerTokenExpired(conn.tokenExpiresAt)) {
      await expireCredentialIfPastExpiry(userId, conn.broker, 'getUserActiveDataSource');
      conn.status = 'expired';
      all[i] = conn;
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
        || c.status === 'reauth_required'
        || c.status === 'revoked'
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

  await setCredentialStatus({
    userId,
    broker,
    newStatus: 'disconnected',
    reason: 'manual_disconnect',
    source: 'disconnectDataSourceBroker',
    clearTokens: true,
  });

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
 * @deprecated Broker market-data providers removed.
 */
export async function getUserBrokerMarketDataProvider(
  _userId: number,
): Promise<never> {
  throw new ActiveDataSourceError(
    'none',
    'Broker market-data providers removed — use IndianAPI warehouse via MarketDataProvider',
  );
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
