/**
 * Shared helpers for BrokerMarketDataProvider adapters.
 * Keep token decrypt + connection lookup here so adapters stay thin.
 *
 * Persistent credential status is managed via credentialStatus.ts —
 * never write `expired` for operational REST/WS failures.
 */

import {
  decryptBrokerCredential,
  getBrokerConnectionById,
  getBrokerConnectionByUserAndBroker,
  getDecryptedAccessTokenForUser,
} from '@/lib/broker/connections';
import {
  applyProviderFailureToCredentialStatus,
  expireCredentialIfPastExpiry,
  isCredentialUsable,
} from '@/lib/broker/connections/credentialStatus';
import type { BrokerConnectionRecord } from '@/lib/broker/connections/types';
import {
  classifyProviderFailure,
  type ClassifyProviderFailureInput,
} from '@/lib/broker/connections/providerFailure';
import type {
  BrokerConnectionContext,
  BrokerProviderName,
  ProviderConnectionStatus,
} from './types';
import { BrokerMarketDataError } from './types';

export interface HydratedBrokerSession {
  connection: BrokerConnectionRecord;
  accessToken: string;
  accountId: string | null;
}

export async function resolveConnection(
  broker: BrokerProviderName,
  context: BrokerConnectionContext,
): Promise<BrokerConnectionRecord | null> {
  if (context.connectionId) {
    const row = await getBrokerConnectionById(context.connectionId);
    if (!row || row.userId !== context.userId || row.broker !== broker) {
      return null;
    }
    return row;
  }
  return getBrokerConnectionByUserAndBroker(context.userId, broker);
}

export async function requireActiveConnection(
  broker: BrokerProviderName,
  context: BrokerConnectionContext,
): Promise<BrokerConnectionRecord> {
  const row = await resolveConnection(broker, context);
  if (!row) {
    throw new BrokerMarketDataError(
      broker,
      'not_connected',
      `${broker} connection not found for user`,
    );
  }

  // Time-based expiry only
  if (row.status === 'active') {
    const expired = await expireCredentialIfPastExpiry(
      context.userId,
      broker,
      'requireActiveConnection',
    );
    if (expired.changed || expired.newStatus === 'expired') {
      throw new BrokerMarketDataError(
        broker,
        'session_expired',
        `${broker} session expired`,
      );
    }
  }

  if (row.status === 'expired') {
    throw new BrokerMarketDataError(
      broker,
      'session_expired',
      `${broker} session expired`,
    );
  }
  if (row.status === 'reauth_required' || row.status === 'revoked') {
    throw new BrokerMarketDataError(
      broker,
      'session_expired',
      `${broker} requires reauthentication`,
    );
  }
  if (row.status !== 'active') {
    throw new BrokerMarketDataError(
      broker,
      'not_connected',
      `${broker} connection status=${row.status}`,
    );
  }
  return row;
}

export function statusFromConnection(
  broker: BrokerProviderName,
  row: BrokerConnectionRecord | null,
  extras: Partial<
    Pick<
      ProviderConnectionStatus,
      'streamConnected' | 'lastTickAt' | 'lastError' | 'detail' | 'state'
    >
  > = {},
): ProviderConnectionStatus {
  if (!row) {
    return {
      broker,
      state: extras.state ?? 'disconnected',
      sessionActive: false,
      streamConnected: extras.streamConnected ?? false,
      lastTickAt: extras.lastTickAt ?? null,
      lastError: extras.lastError ?? null,
      detail: extras.detail ?? 'no_connection',
    };
  }

  let state: ProviderConnectionStatus['state'] = 'disconnected';
  if (row.status === 'active') state = 'connected';
  else if (row.status === 'expired' || row.status === 'reauth_required' || row.status === 'revoked') {
    state = 'expired';
  } else if (row.status === 'error') state = 'error';
  else if (row.status === 'pending') state = 'connecting';

  return {
    broker,
    state: extras.state ?? state,
    sessionActive: row.status === 'active' && isCredentialUsable(row),
    streamConnected: extras.streamConnected ?? false,
    lastTickAt: extras.lastTickAt ?? null,
    lastError: extras.lastError ?? null,
    detail: extras.detail ?? row.status,
  };
}

export function notImplemented(
  broker: BrokerProviderName,
  capability: string,
): never {
  throw new BrokerMarketDataError(
    broker,
    'not_implemented',
    `${broker} market-data capability not implemented yet: ${capability}`,
  );
}

/**
 * Load + decrypt the access token for this user's broker connection.
 * Tokens never appear on BrokerConnectionContext.
 */
export async function hydrateBrokerSession(
  broker: BrokerProviderName,
  context: BrokerConnectionContext,
): Promise<HydratedBrokerSession> {
  const connection = await requireActiveConnection(broker, context);

  let accessToken: string | null = null;
  if (context.connectionId && connection.accessTokenEncrypted) {
    try {
      accessToken = decryptBrokerCredential(connection.accessTokenEncrypted);
    } catch {
      accessToken = null;
    }
  } else {
    accessToken = await getDecryptedAccessTokenForUser(context.userId, broker);
  }

  if (!accessToken?.trim()) {
    throw new BrokerMarketDataError(
      broker,
      'not_connected',
      `${broker} access token unavailable — reconnect on /data-source`,
    );
  }

  // Time-based expiry only — never mark expired from hydrate alone without past expiry
  const expiryCheck = await expireCredentialIfPastExpiry(
    context.userId,
    broker,
    'hydrateBrokerSession',
  );
  if (expiryCheck.newStatus === 'expired') {
    throw new BrokerMarketDataError(
      broker,
      'session_expired',
      `${broker} session expired`,
    );
  }

  return {
    connection,
    accessToken: accessToken.trim(),
    accountId: connection.brokerAccountId,
  };
}

/**
 * @deprecated Prefer applyProviderAuthFailure / expireCredentialIfPastExpiry.
 * Kept as a thin alias that ONLY expires when token time has passed.
 */
export async function markProviderSessionExpired(
  broker: BrokerProviderName,
  userId: number,
): Promise<void> {
  await expireCredentialIfPastExpiry(userId, broker, 'markProviderSessionExpired');
}

/**
 * Apply a classified provider failure. Temporary failures leave credential status alone.
 */
export async function applyProviderAuthFailure(
  broker: BrokerProviderName,
  userId: number,
  failure: ClassifyProviderFailureInput,
  source: string,
): Promise<{ category: string; persisted: boolean }> {
  const result = await applyProviderFailureToCredentialStatus(
    userId,
    broker,
    failure,
    source,
  );
  return { category: result.category, persisted: result.persisted };
}

/**
 * Narrow check for confirmed session/token invalidation messages.
 * Generic "fail" / "invalid" / "denied" alone return false.
 */
export function isSessionExpiryMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  const category = classifyProviderFailure({
    providerErrorMessage: message,
    confirmedCredentialInvalid: false,
  });
  return category === 'reauth_required' || category === 'credentials_revoked';
}

export { classifyProviderFailure };
export type { ClassifyProviderFailureInput };
