'use client';

// ════════════════════════════════════════════════════════════════
//  Kite Connect — browser session storage (Phase 2)
//
//  Persists post-login session fields in sessionStorage only.
//  Never stores API key, API secret, or request_token.
// ════════════════════════════════════════════════════════════════

export interface KiteBrowserSession {
  accessToken: string;
  kiteUserId: string;
  authenticatedAt: string;
}

const STORAGE_KEY = 'quantorus:kite-session';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeSession(value: unknown): KiteBrowserSession | null {
  if (!value || typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  const { accessToken, kiteUserId, authenticatedAt } = record;

  if (
    !isNonEmptyString(accessToken)
    || !isNonEmptyString(kiteUserId)
    || !isNonEmptyString(authenticatedAt)
  ) {
    return null;
  }

  return {
    accessToken: accessToken.trim(),
    kiteUserId: kiteUserId.trim(),
    authenticatedAt: authenticatedAt.trim(),
  };
}

function validateSessionForSave(session: KiteBrowserSession): KiteBrowserSession {
  if (!session || typeof session !== 'object') {
    clearKiteSession();
    throw new Error(
      'Invalid Kite browser session: expected an object with accessToken, kiteUserId, and authenticatedAt',
    );
  }

  const invalidFields: string[] = [];
  if (!isNonEmptyString(session.accessToken)) invalidFields.push('accessToken');
  if (!isNonEmptyString(session.kiteUserId)) invalidFields.push('kiteUserId');
  if (!isNonEmptyString(session.authenticatedAt)) invalidFields.push('authenticatedAt');

  if (invalidFields.length > 0) {
    clearKiteSession();
    throw new Error(
      `Invalid Kite browser session: ${invalidFields.join(', ')} must be non-empty strings`,
    );
  }

  return {
    accessToken: session.accessToken.trim(),
    kiteUserId: session.kiteUserId.trim(),
    authenticatedAt: session.authenticatedAt.trim(),
  };
}

/** Persist a validated Kite browser session (tab-scoped). No-op during SSR. */
export function saveKiteSession(session: KiteBrowserSession): void {
  const normalized = validateSessionForSave(session);

  if (typeof window === 'undefined') return;

  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

/** Read the stored session, or null if absent, invalid, or SSR. Clears malformed data. */
export function getKiteSession(): KiteBrowserSession | null {
  if (typeof window === 'undefined') return null;

  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed: unknown = JSON.parse(raw);
    const session = normalizeSession(parsed);
    if (!session) {
      clearKiteSession();
      return null;
    }

    return session;
  } catch {
    clearKiteSession();
    return null;
  }
}

/** Remove the stored browser session. No-op during SSR. */
export function clearKiteSession(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(STORAGE_KEY);
}
