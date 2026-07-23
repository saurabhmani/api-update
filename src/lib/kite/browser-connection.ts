/**
 * Client-side Kite connection helpers (no browser token storage).
 */

import { clearKiteSession } from '@/lib/kite/browser-session';
import {
  REMOTE_INVALIDATION_WARNING,
  shouldApplyVerificationResult,
} from '@/lib/kite/invalidate-remote-session';

export type LocalKiteSession = {
  kiteUserId: string;
  authenticatedAt: string;
};

export type KiteProfileOk = {
  ok: true;
  userId: string;
  userName: string;
  email: string;
  broker: string;
};

export type KiteProfileFail = {
  ok: false;
  kind: 'unauthorized' | 'temporary' | 'invalid';
  message: string;
};

export type KiteProfileResult = KiteProfileOk | KiteProfileFail;

export type ConnectedStateResult =
  | { status: 'connected'; userName: string; userId: string; broker: string }
  | { status: 'temporary_failure'; message: string }
  | { status: 'verification_failed'; message: string };

/**
 * Verify Kite profile using the authenticated Quant cookie session.
 * Server resolves the decrypted broker token — no Bearer token from the browser.
 */
export async function verifyKiteProfile(
  _session?: LocalKiteSession | null,
): Promise<KiteProfileResult> {
  clearKiteSession();

  try {
    const response = await fetch('/api/kite/profile', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });

    if (response.status === 401 || response.status === 404) {
      return {
        ok: false,
        kind: 'unauthorized',
        message: 'Zerodha is not connected. Connect again to continue.',
      };
    }

    if (response.status >= 500) {
      return {
        ok: false,
        kind: 'temporary',
        message: 'Unable to verify Zerodha right now. Retry shortly.',
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        kind: 'invalid',
        message: 'Zerodha verification failed. Please reconnect.',
      };
    }

    const data: unknown = await response.json().catch(() => null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, kind: 'invalid', message: 'Invalid profile response.' };
    }

    const payload = data as Record<string, unknown>;
    if (typeof payload.accessToken === 'string' && payload.accessToken.trim()) {
      return { ok: false, kind: 'invalid', message: 'Invalid profile response.' };
    }

    const userId =
      typeof payload.userId === 'string' && payload.userId.trim()
        ? payload.userId.trim()
        : typeof payload.user_id === 'string' && payload.user_id.trim()
          ? payload.user_id.trim()
          : '';
    const userName =
      typeof payload.userName === 'string' && payload.userName.trim()
        ? payload.userName.trim()
        : typeof payload.user_name === 'string' && payload.user_name.trim()
          ? payload.user_name.trim()
          : '';
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    const broker = typeof payload.broker === 'string' ? payload.broker.trim() : '';

    if (!userId || !userName || !email || !broker) {
      return { ok: false, kind: 'invalid', message: 'Incomplete Kite profile.' };
    }

    return { ok: true, userId, userName, email, broker };
  } catch {
    return {
      ok: false,
      kind: 'temporary',
      message: 'Network error while verifying Zerodha.',
    };
  }
}

export function resolveConnectedState(
  _session: LocalKiteSession | null,
  result: KiteProfileResult,
): ConnectedStateResult {
  if (result.ok === true) {
    return {
      status: 'connected',
      userName: result.userName,
      userId: result.userId,
      broker: result.broker,
    };
  }

  if (result.ok === false && result.kind === 'temporary') {
    return { status: 'temporary_failure', message: result.message };
  }

  return {
    status: 'verification_failed',
    message: result.ok === false ? result.message : 'Verification failed.',
  };
}

export type DisconnectOutcome =
  | { kind: 'done'; warning?: string }
  | { kind: 'suppressed' };

/**
 * Disconnect Zerodha via authenticated broker API (server clears tokens).
 */
export async function disconnectKiteSession(
  options?: { generation?: number; currentGeneration?: () => number },
): Promise<DisconnectOutcome> {
  clearKiteSession();

  const generation = options?.generation;
  const currentGeneration = options?.currentGeneration;

  try {
    const response = await fetch('/api/brokers/zerodha/disconnect', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });

    if (
      generation !== undefined
      && currentGeneration
      && !shouldApplyVerificationResult(generation, currentGeneration())
    ) {
      return { kind: 'suppressed' };
    }

    if (!response.ok) {
      return { kind: 'done', warning: REMOTE_INVALIDATION_WARNING };
    }

    return { kind: 'done' };
  } catch {
    if (
      generation !== undefined
      && currentGeneration
      && !shouldApplyVerificationResult(generation, currentGeneration())
    ) {
      return { kind: 'suppressed' };
    }
    return { kind: 'done', warning: REMOTE_INVALIDATION_WARNING };
  }
}

/** @deprecated Prefer disconnectKiteSession */
export async function disconnectKite(): Promise<{ ok: true } | { ok: false; message: string }> {
  const outcome = await disconnectKiteSession();
  if (outcome.kind === 'suppressed') return { ok: true };
  if (outcome.warning) return { ok: false, message: outcome.warning };
  return { ok: true };
}
