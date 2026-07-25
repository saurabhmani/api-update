// Data-source broker connection types (Zerodha / Shoonya)

export type DataSourceBroker = 'zerodha' | 'shoonya';

export type BrokerConnectionStatus =
  | 'pending'
  | 'active'
  | 'expired'
  | 'revoked'
  | 'error'
  | 'disconnected';

export interface BrokerConnectionRecord {
  id: string;
  userId: number;
  broker: DataSourceBroker;
  brokerAccountId: string | null;
  brokerUserName: string | null;
  accessTokenEncrypted: string | null;
  refreshTokenEncrypted: string | null;
  tokenExpiresAt: string | null;
  lastAuthenticatedAt: string | null;
  lastUsedAt: string | null;
  status: BrokerConnectionStatus;
  isPrimary: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** Safe fields returned to the frontend — never includes tokens. */
export interface SafeBrokerConnectionSummary {
  broker: DataSourceBroker;
  status: BrokerConnectionStatus;
  connected: boolean;
  isActiveDataSource: boolean;
  accountId: string | null;
  userName: string | null;
  expiresAt: string | null;
  displayName: string;
  updatedAt: string;
}

/** Safe fields returned to the frontend — never includes tokens. */
export interface SafeBrokerStatus {
  connected: boolean;
  broker: DataSourceBroker | null;
  status: BrokerConnectionStatus | 'none';
  accountId: string | null;
  userName: string | null;
  expiresAt: string | null;
  displayName: string | null;
  /** True when connected brokers exist but none is the explicit active data source. */
  needsSelection?: boolean;
  /** All known connections for this user (safe). */
  connections?: SafeBrokerConnectionSummary[];
  /** Explicit active data-source broker when resolved. */
  activeDataSource?: DataSourceBroker | null;
  /** Live-feed freshness for the active source (Phase 12). */
  feedStatus?: string;
  lastLiveDataAt?: number | null;
  lastLiveDataAtIso?: string | null;
  feedError?: string | null;
}

export type BrokerAuthTransactionStatus =
  | 'pending'
  | 'completed'
  | 'expired'
  | 'used'
  | 'failed';

export interface BrokerAuthTransaction {
  id: string;
  userId: number;
  broker: DataSourceBroker;
  stateHash: string | null;
  status: BrokerAuthTransactionStatus;
  expiresAt: string;
  completedAt: string | null;
  createdAt: string;
}

export const BROKER_DISPLAY_NAMES: Record<DataSourceBroker, string> = {
  zerodha: 'Zerodha Kite',
  shoonya: 'Shoonya',
};

export function isDataSourceBroker(value: string): value is DataSourceBroker {
  return value === 'zerodha' || value === 'shoonya';
}

/** Map legacy broker names used elsewhere in the codebase. */
export function normalizeDataSourceBroker(value: string): DataSourceBroker | null {
  const v = value.trim().toLowerCase();
  if (v === 'zerodha' || v === 'kite') return 'zerodha';
  if (v === 'shoonya') return 'shoonya';
  return null;
}
