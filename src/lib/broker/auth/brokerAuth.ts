// Broker Authentication Module — token storage + refresh

import { getBrokerAdapter, defaultBrokerName } from '../adapter/registry';
import { paperAdapter } from '../adapter/paperAdapter';
import {
  getBrokerConnection,
  upsertBrokerConnection,
  type BrokerConnectionRow,
} from '../repository/brokerRepository';
import { logFailure } from '../sdk/failureLog';
import { withRetry } from '../sdk/retry';
import type { BrokerCredentials, BrokerName } from '../types';

export function isTokenExpired(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now() + 60_000;
}

export async function connectBroker(
  userId: number,
  broker: BrokerName,
  credentials: BrokerCredentials,
): Promise<{ ok: boolean; connection?: BrokerConnectionRow; error?: string }> {
  if (broker === 'paper') paperAdapter.setUserId(userId);

  const adapter = getBrokerAdapter(broker);
  try {
    const result = await withRetry(() => adapter.connect(credentials));
    if (!result.ok) {
      await logFailure({ userId, broker, operation: 'connect', errorMessage: result.error ?? 'Connect failed' });
      return { ok: false, error: result.error };
    }
    const conn = await upsertBrokerConnection(userId, broker, credentials, 'connected');
    return { ok: true, connection: conn };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Connect failed';
    await logFailure({ userId, broker, operation: 'connect', errorMessage: msg });
    return { ok: false, error: msg };
  }
}

export async function refreshBrokerToken(
  userId: number,
  broker?: BrokerName,
): Promise<{ ok: boolean; credentials?: BrokerCredentials; error?: string }> {
  const name = broker ?? defaultBrokerName();
  const conn = await getBrokerConnection(userId, name);
  if (!conn) return { ok: false, error: 'No broker connection' };

  const adapter = getBrokerAdapter(name);
  try {
    const refreshed = await withRetry(() => adapter.refreshToken(conn.credentials));
    if (!refreshed) return { ok: false, error: 'Token refresh returned null' };
    await upsertBrokerConnection(userId, name, refreshed, 'connected');
    return { ok: true, credentials: refreshed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Refresh failed';
    await logFailure({ userId, broker: name, operation: 'refresh_token', errorMessage: msg });
    // Do NOT mark credentials expired on refresh network/outage failures.
    // Explicit provider rejection is handled by adapters calling setCredentialStatus.
    return { ok: false, error: msg };
  }
}

export async function getValidCredentials(
  userId: number,
  broker?: BrokerName,
): Promise<{ ok: boolean; credentials?: BrokerCredentials; broker?: BrokerName; error?: string }> {
  const name = broker ?? defaultBrokerName();
  let conn = await getBrokerConnection(userId, name);

  if (!conn && name === 'simulated') {
    const simCreds: BrokerCredentials = {
      accessToken: `sim_${userId}`,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    await upsertBrokerConnection(userId, name, simCreds, 'connected');
    conn = await getBrokerConnection(userId, name);
  }

  if (!conn) return { ok: false, error: 'Broker not connected' };

  if (isTokenExpired(conn.credentials.expiresAt)) {
    const refreshed = await refreshBrokerToken(userId, name);
    if (!refreshed.ok) return { ok: false, error: refreshed.error };
    conn = await getBrokerConnection(userId, name);
  }

  const adapter = getBrokerAdapter(name);
  const valid = await adapter.validateConnection(conn!.credentials);
  if (!valid.ok) return { ok: false, error: valid.reason ?? 'Invalid connection' };

  return { ok: true, credentials: conn!.credentials, broker: name };
}

export async function disconnectBroker(
  userId: number,
  broker?: BrokerName,
): Promise<{ ok: boolean; error?: string }> {
  const name = broker ?? defaultBrokerName();
  try {
    const adapter = getBrokerAdapter(name);
    await adapter.disconnect();
    const { disconnectBrokerAccount } = await import('../repository/brokerRepository');
    await disconnectBrokerAccount(userId, name);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Disconnect failed';
    await logFailure({ userId, broker: name, operation: 'disconnect', errorMessage: msg });
    return { ok: false, error: msg };
  }
}

export async function getBrokerAuthStatus(userId: number, broker?: BrokerName) {
  const name = broker ?? defaultBrokerName();
  const conn = await getBrokerConnection(userId, name);
  return {
    broker: name,
    connected: conn?.status === 'connected',
    status: conn?.status ?? 'disconnected',
    expiresAt: conn?.credentials.expiresAt ?? null,
    tokenExpired: isTokenExpired(conn?.credentials.expiresAt),
    brokerUserId: conn?.credentials.brokerUserId ?? null,
  };
}
