// Safe broker connection status + post-login routing helpers

import { getUserActiveDataSource } from './activeDataSource';
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

/**
 * Post-login destination. Market data uses IndianAPI warehouse — a broker
 * connection is optional. Always allow entry to the dashboard.
 */
export async function resolvePostLoginDestination(
  _userId: number,
): Promise<PostLoginDestination> {
  return { path: '/dashboard' };
}

export function brokerDisplayName(broker: DataSourceBroker): string {
  return BROKER_DISPLAY_NAMES[broker];
}
