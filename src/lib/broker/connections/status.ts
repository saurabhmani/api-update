// Safe broker connection status + post-login routing helpers

import { getUserActiveDataSource } from './activeDataSource';
import { listBrokerConnectionsForUser } from './repository';
import { isBrokerTokenExpired } from './expiry';
import {
  BROKER_DISPLAY_NAMES,
  type BrokerConnectionRecord,
  type DataSourceBroker,
} from './types';

export {
  getUserActiveDataSource,
  setUserActiveDataSource,
  disconnectDataSourceBroker,
  getSafeBrokerStatus,
  hasActiveBrokerConnection,
  getUserBrokerMarketDataProvider,
  resolvePrimaryFlagOnConnect,
  ActiveDataSourceError,
} from './activeDataSource';
export type {
  UserActiveDataSource,
  ActiveDataSourceReason,
  ActiveDataSourceErrorCode,
} from './activeDataSource';

/**
 * Resolve the user's active data-source connection row.
 * Returns null when none is selected / needsSelection / disconnected.
 */
export async function resolveActiveBrokerConnection(
  userId: number,
): Promise<BrokerConnectionRecord | null> {
  const active = await getUserActiveDataSource(userId);
  if (active.needsSelection || !active.connection) return null;
  return active.connection;
}

export type PostLoginDestination =
  | { path: '/dashboard' }
  | { path: '/data-source'; reason?: 'session_expired' | 'select_data_source' };

export async function resolvePostLoginDestination(
  userId: number,
): Promise<PostLoginDestination> {
  try {
    const active = await getUserActiveDataSource(userId);
    if (active.provider && !active.needsSelection) {
      return { path: '/dashboard' };
    }
    if (active.needsSelection) {
      return { path: '/data-source', reason: 'select_data_source' };
    }

    const connections = await listBrokerConnectionsForUser(userId);
    const expiredPrimary = connections.find(
      (c) =>
        c.status === 'expired'
        || (c.status === 'active' && isBrokerTokenExpired(c.tokenExpiresAt)),
    );
    if (expiredPrimary || active.reason === 'expired') {
      return { path: '/data-source', reason: 'session_expired' };
    }

    return { path: '/data-source' };
  } catch {
    return { path: '/data-source' };
  }
}

export function brokerDisplayName(broker: DataSourceBroker): string {
  return BROKER_DISPLAY_NAMES[broker];
}
