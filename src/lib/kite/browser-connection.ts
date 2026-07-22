'use client';

import { clearKiteSession, getKiteSession } from '@/lib/kite/browser-session';
import {
  invalidateRemoteKiteSession,
  localDisconnectState,
  REMOTE_INVALIDATION_WARNING,
} from '@/lib/kite/invalidate-remote-session';

export { REMOTE_INVALIDATION_WARNING };

export interface LocalKiteSession {
  kiteUserId: string;
  accessToken: string;
  authenticatedAt: string;
}

export interface KiteProfilePayload {
  userId: string;
  userName: string;
  email: string;
  broker: string;
}

export type ProfileVerificationResult =
  | { kind: 'success'; profile: KiteProfilePayload }
  | { kind: 'unauthorized' }
  | { kind: 'temporary'; message: string }
  | { kind: 'invalid' };

export type DisconnectOutcome =
  | { kind: 'suppressed' }
  | { kind: 'cleared'; remoteInvalidationConfirmed: boolean; warning?: string };

const inFlightVerifications = new Map<string, Promise<ProfileVerificationResult>>();
let disconnectInFlight = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseKiteProfilePayload(data: unknown): KiteProfilePayload | null {
  if (!isRecord(data)) return null;

  const userId = data.userId;
  const userName = data.userName;
  const email = data.email;
  const broker = data.broker;

  if (
    !isNonEmptyString(userId)
    || !isNonEmptyString(userName)
    || !isNonEmptyString(email)
    || !isNonEmptyString(broker)
  ) {
    return null;
  }

  return {
    userId: userId.trim(),
    userName: userName.trim(),
    email: email.trim(),
    broker: broker.trim(),
  };
}

function sessionVerificationKey(session: LocalKiteSession): string {
  return `${session.kiteUserId}\u0000${session.accessToken}\u0000${session.authenticatedAt}`;
}

async function fetchKiteProfile(accessToken: string): Promise<ProfileVerificationResult> {
  try {
    const response = await fetch('/api/kite/profile', {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: 'same-origin',
      cache: 'no-store',
    });

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      if (response.status === 401) return { kind: 'unauthorized' };
      if (response.status === 502 || response.status === 503) {
        return { kind: 'temporary', message: 'Kite verification is temporarily unavailable.' };
      }
      return { kind: 'temporary', message: 'Unable to verify Kite session right now.' };
    }

    if (response.status === 401) return { kind: 'unauthorized' };

    if (response.status === 502 || response.status === 503) {
      const message =
        isRecord(data) && isNonEmptyString(data.error)
          ? data.error
          : 'Kite verification is temporarily unavailable.';
      return { kind: 'temporary', message };
    }

    if (!response.ok) {
      return { kind: 'temporary', message: 'Unable to verify Kite session right now.' };
    }

    const profile = parseKiteProfilePayload(data);
    if (!profile) return { kind: 'invalid' };

    // Best-effort: register browser token as server active session for market data / CLI.
    try {
      void fetch('/api/kite/session', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
        credentials: 'same-origin',
        cache: 'no-store',
      }).catch(() => undefined);
    } catch {
      // ignore sync registration failures
    }

    return { kind: 'success', profile };
  } catch {
    return { kind: 'temporary', message: 'Network error while verifying Kite session.' };
  }
}

export function verifyKiteProfile(session: LocalKiteSession): Promise<ProfileVerificationResult> {
  const key = sessionVerificationKey(session);
  const existing = inFlightVerifications.get(key);
  if (existing) return existing;

  const promise = fetchKiteProfile(session.accessToken).finally(() => {
    inFlightVerifications.delete(key);
  });

  inFlightVerifications.set(key, promise);
  return promise;
}

export function resolveConnectedState(
  session: LocalKiteSession,
  result: ProfileVerificationResult,
):
  | { status: 'connected'; userName: string; userId: string; broker: string }
  | { status: 'verification_failed'; message: string; clearedLocal: boolean }
  | { status: 'temporary_failure'; message: string; clearedLocal: boolean } {
  if (result.kind === 'unauthorized') {
    clearKiteSession();
    return {
      status: 'verification_failed',
      message: 'Your Zerodha session has expired. Reconnect to continue.',
      clearedLocal: true,
    };
  }

  if (result.kind === 'temporary') {
    return {
      status: 'temporary_failure',
      message: result.message,
      clearedLocal: false,
    };
  }

  if (result.kind === 'invalid' || result.profile.userId !== session.kiteUserId) {
    clearKiteSession();
    return {
      status: 'verification_failed',
      message: 'Kite session verification failed. Reconnect to continue.',
      clearedLocal: true,
    };
  }

  return {
    status: 'connected',
    userName: result.profile.userName,
    userId: result.profile.userId,
    broker: result.profile.broker,
  };
}

export async function disconnectKiteSession(): Promise<DisconnectOutcome> {
  if (disconnectInFlight) {
    return { kind: 'suppressed' };
  }

  const session = getKiteSession();
  const capturedAccessToken = session?.accessToken?.trim() ?? '';

  disconnectInFlight = true;
  clearKiteSession();

  if (!capturedAccessToken) {
    disconnectInFlight = false;
    return { kind: 'cleared', remoteInvalidationConfirmed: true };
  }

  try {
    const remoteInvalidationConfirmed = await invalidateRemoteKiteSession(capturedAccessToken);
    const next = localDisconnectState(remoteInvalidationConfirmed);
    return {
      kind: 'cleared',
      remoteInvalidationConfirmed,
      warning: next.remoteInvalidationWarning,
    };
  } finally {
    disconnectInFlight = false;
  }
}

export function getInFlightVerificationCount(): number {
  return inFlightVerifications.size;
}

export function isDisconnectInFlight(): boolean {
  return disconnectInFlight;
}

export function resetBrowserConnectionState(): void {
  inFlightVerifications.clear();
  disconnectInFlight = false;
}
