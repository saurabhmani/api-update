/**
 * Shared helpers for BrokerMarketDataProvider adapters.
 * Keep token decrypt + connection lookup here so adapters stay thin.
 */

import {
  decryptBrokerCredential,
  getBrokerConnectionById,
  getBrokerConnectionByUserAndBroker,
  getDecryptedAccessTokenForUser,
  markBrokerConnectionStatus,
} from '@/lib/broker/connections';
import type { BrokerConnectionRecord } from '@/lib/broker/connections/types';
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
  if (row.status === 'expired') {
    throw new BrokerMarketDataError(
      broker,
      'session_expired',
      `${broker} session expired`,
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
  else if (row.status === 'expired') state = 'expired';
  else if (row.status === 'error') state = 'error';
  else if (row.status === 'pending') state = 'connecting';

  return {
    broker,
    state: extras.state ?? state,
    sessionActive: row.status === 'active',
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

  if (
    connection.tokenExpiresAt
    && Number.isFinite(Date.parse(connection.tokenExpiresAt))
    && Date.parse(connection.tokenExpiresAt) <= Date.now()
  ) {
    await markBrokerConnectionStatus(context.userId, broker, 'expired').catch(() => undefined);
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

export async function markProviderSessionExpired(
  broker: BrokerProviderName,
  userId: number,
): Promise<void> {
  await markBrokerConnectionStatus(userId, broker, 'expired').catch(() => undefined);
}

export function isSessionExpiryMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return /session\s*(expired|invalid)|invalid\s*session|logged\s*out|not\s*logged|token\s*(expired|invalid)|authorization\s*failed|unauthori[sz]ed/i.test(
    message,
  );
}
