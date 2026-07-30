/**
 * Centralized persistent credential-status transitions for all data-source brokers.
 *
 * Rules:
 *  - `expired` ONLY when token_expires_at <= now
 *  - Provider rejection → `revoked` or `reauth_required` (never `expired`)
 *  - Temporary / operational failures → no persistent status change
 */

import { logger } from '@/lib/logger';
import { isBrokerTokenExpired, mysqlUtcDateTimeToMs } from './expiry';
import {
  getBrokerConnectionByUserAndBroker,
  markBrokerConnectionStatus,
  mergeBrokerConnectionMetadata,
} from './repository';
import type {
  BrokerConnectionRecord,
  BrokerConnectionStatus,
  DataSourceBroker,
} from './types';
import {
  classifyProviderFailure,
  shouldPersistCredentialDemotion,
  type ClassifyProviderFailureInput,
  type ProviderFailureCategory,
} from './providerFailure';

const log = logger.child({ component: 'broker.credentialStatus' });

export type CredentialStatusChangeReason =
  | 'time_expiry'
  | 'provider_credentials_revoked'
  | 'provider_reauth_required'
  | 'manual_disconnect'
  | 'oauth_success'
  | 'token_refresh_success'
  | 'misclassified_expired_repair'
  | 'explicit';

export interface SetCredentialStatusInput {
  userId: number;
  broker: DataSourceBroker;
  newStatus: BrokerConnectionStatus;
  reason: CredentialStatusChangeReason;
  providerErrorCode?: string | null;
  providerErrorMessage?: string | null;
  source?: string;
  clearTokens?: boolean;
  /** Extra metadata patch (never tokens). */
  metadataPatch?: Record<string, unknown>;
}

export interface CredentialStatusChangeResult {
  changed: boolean;
  previousStatus: BrokerConnectionStatus | null;
  newStatus: BrokerConnectionStatus;
  skippedReason?: string;
}

/** Statuses that mean the connection is not usable for market data. */
export const UNUSABLE_CREDENTIAL_STATUSES = new Set<BrokerConnectionStatus>([
  'expired',
  'revoked',
  'reauth_required',
  'disconnected',
  'error',
  'pending',
]);

/**
 * Effective usability: requires active credential status AND non-expired token.
 * Revoked / reauth_required stay unusable even if token_expires_at is future.
 */
export function isCredentialUsable(
  conn: Pick<BrokerConnectionRecord, 'status' | 'accessTokenEncrypted' | 'tokenExpiresAt'>,
): boolean {
  if (conn.status !== 'active') return false;
  if (!conn.accessTokenEncrypted) return false;
  if (isBrokerTokenExpired(conn.tokenExpiresAt)) return false;
  return true;
}

/**
 * Display / summary status: derive time-expiry from timestamp when still active.
 * Does NOT rewrite revoked/reauth_required to expired.
 */
export function effectiveCredentialStatus(
  conn: Pick<BrokerConnectionRecord, 'status' | 'tokenExpiresAt'>,
): BrokerConnectionStatus {
  if (conn.status === 'active' && isBrokerTokenExpired(conn.tokenExpiresAt)) {
    return 'expired';
  }
  return conn.status;
}

/**
 * Persist a credential status change with validation + structured logging.
 * Blocks arbitrary `expired` writes that are not backed by a past expiry timestamp.
 */
export async function setCredentialStatus(
  input: SetCredentialStatusInput,
): Promise<CredentialStatusChangeResult> {
  const existing = await getBrokerConnectionByUserAndBroker(input.userId, input.broker);
  const previousStatus = existing?.status ?? null;

  if (input.newStatus === 'expired') {
    const expiresAt = existing?.tokenExpiresAt ?? null;
    if (!isBrokerTokenExpired(expiresAt)) {
      log.warn('blocked_invalid_expired_transition', {
        userId: input.userId,
        provider: input.broker,
        connectionId: existing?.id ?? null,
        previousStatus,
        newStatus: 'expired',
        reason: input.reason,
        tokenExpiresAt: expiresAt,
        source: input.source ?? null,
        note: 'expired only allowed when token_expires_at <= now',
      });
      return {
        changed: false,
        previousStatus,
        newStatus: previousStatus ?? 'disconnected',
        skippedReason: 'token_not_past_expiry',
      };
    }
  }

  if (previousStatus === input.newStatus && !input.clearTokens && !input.metadataPatch) {
    return { changed: false, previousStatus, newStatus: input.newStatus };
  }

  await markBrokerConnectionStatus(
    input.userId,
    input.broker,
    input.newStatus,
    input.clearTokens === true,
  );

  if (input.metadataPatch && Object.keys(input.metadataPatch).length > 0) {
    try {
      await mergeBrokerConnectionMetadata(input.userId, input.broker, {
        ...input.metadataPatch,
        lastCredentialStatusReason: input.reason,
        lastCredentialStatusAt: new Date().toISOString(),
        ...(input.providerErrorCode
          ? { lastProviderErrorCode: String(input.providerErrorCode).slice(0, 80) }
          : {}),
        ...(input.providerErrorMessage
          ? { lastProviderErrorMessage: String(input.providerErrorMessage).slice(0, 160) }
          : {}),
      });
    } catch {
      /* non-fatal */
    }
  } else if (input.reason !== 'explicit') {
    try {
      await mergeBrokerConnectionMetadata(input.userId, input.broker, {
        lastCredentialStatusReason: input.reason,
        lastCredentialStatusAt: new Date().toISOString(),
        ...(input.providerErrorCode
          ? { lastProviderErrorCode: String(input.providerErrorCode).slice(0, 80) }
          : {}),
        ...(input.providerErrorMessage
          ? { lastProviderErrorMessage: String(input.providerErrorMessage).slice(0, 160) }
          : {}),
      });
    } catch {
      /* non-fatal */
    }
  }

  log.info('credential_status_changed', {
    userId: input.userId,
    provider: input.broker,
    connectionId: existing?.id ?? null,
    previousStatus,
    newStatus: input.newStatus,
    reason: input.reason,
    providerErrorCode: input.providerErrorCode ?? null,
    providerErrorMessage: input.providerErrorMessage
      ? String(input.providerErrorMessage).slice(0, 160)
      : null,
    tokenExpiresAt: existing?.tokenExpiresAt ?? null,
    source: input.source ?? null,
    timestamp: new Date().toISOString(),
  });

  return { changed: true, previousStatus, newStatus: input.newStatus };
}

/**
 * Mark connection expired only when token_expires_at is in the past.
 */
export async function expireCredentialIfPastExpiry(
  userId: number,
  broker: DataSourceBroker,
  source = 'time_expiry_check',
): Promise<CredentialStatusChangeResult> {
  const existing = await getBrokerConnectionByUserAndBroker(userId, broker);
  if (!existing) {
    return { changed: false, previousStatus: null, newStatus: 'disconnected', skippedReason: 'missing' };
  }
  if (!isBrokerTokenExpired(existing.tokenExpiresAt)) {
    return {
      changed: false,
      previousStatus: existing.status,
      newStatus: existing.status,
      skippedReason: 'token_not_past_expiry',
    };
  }
  if (existing.status === 'expired') {
    return { changed: false, previousStatus: 'expired', newStatus: 'expired' };
  }
  // Manual disconnect / revoked stay as-is except we still record expiry when active/reauth
  if (existing.status === 'disconnected' || existing.status === 'revoked') {
    return {
      changed: false,
      previousStatus: existing.status,
      newStatus: existing.status,
      skippedReason: 'terminal_status',
    };
  }
  return setCredentialStatus({
    userId,
    broker,
    newStatus: 'expired',
    reason: 'time_expiry',
    source,
  });
}

/**
 * Handle a provider failure: demote credentials only for confirmed categories.
 */
export async function applyProviderFailureToCredentialStatus(
  userId: number,
  broker: DataSourceBroker,
  failure: ClassifyProviderFailureInput,
  source: string,
): Promise<{
  category: ProviderFailureCategory;
  persisted: boolean;
  result: CredentialStatusChangeResult | null;
}> {
  const category = classifyProviderFailure(failure);

  if (!shouldPersistCredentialDemotion(category)) {
    log.info('runtime_provider_failure_no_credential_change', {
      userId,
      provider: broker,
      category,
      httpStatus: failure.httpStatus ?? null,
      providerErrorCode: failure.providerErrorCode ?? null,
      providerErrorMessage: failure.providerErrorMessage
        ? String(failure.providerErrorMessage).slice(0, 160)
        : null,
      source,
      transport: failure.transport ?? null,
    });
    return { category, persisted: false, result: null };
  }

  const newStatus: BrokerConnectionStatus =
    category === 'credentials_revoked' ? 'revoked' : 'reauth_required';

  const result = await setCredentialStatus({
    userId,
    broker,
    newStatus,
    reason:
      category === 'credentials_revoked'
        ? 'provider_credentials_revoked'
        : 'provider_reauth_required',
    providerErrorCode: failure.providerErrorCode,
    providerErrorMessage: failure.providerErrorMessage,
    source,
    metadataPatch: {
      providerRejectionConfirmed: true,
      providerRejectionCategory: category,
    },
  });

  return { category, persisted: result.changed, result };
}

/**
 * Repair rows incorrectly stored as `expired` while token_expires_at is still future.
 * Does NOT reactivate — moves to `reauth_required` so reconnect is required.
 */
export async function repairMisclassifiedExpiredCredential(
  conn: BrokerConnectionRecord,
): Promise<BrokerConnectionRecord> {
  if (conn.status !== 'expired') return conn;
  if (isBrokerTokenExpired(conn.tokenExpiresAt)) return conn;
  if (conn.metadata?.providerRejectionConfirmed === true) {
    // Explicit rejection was stored under wrong label — normalize to reauth_required
    await setCredentialStatus({
      userId: conn.userId,
      broker: conn.broker,
      newStatus: 'reauth_required',
      reason: 'misclassified_expired_repair',
      source: 'repair_misclassified_expired',
      metadataPatch: { repairedFromExpired: true },
    });
    return { ...conn, status: 'reauth_required' };
  }

  await setCredentialStatus({
    userId: conn.userId,
    broker: conn.broker,
    newStatus: 'reauth_required',
    reason: 'misclassified_expired_repair',
    source: 'repair_misclassified_expired',
    metadataPatch: {
      repairedFromExpired: true,
      repairedNote: 'status was expired while token_expires_at still future',
    },
  });
  return { ...conn, status: 'reauth_required' };
}

export function tokenExpiresAtMs(value: unknown): number | null {
  return mysqlUtcDateTimeToMs(value);
}
