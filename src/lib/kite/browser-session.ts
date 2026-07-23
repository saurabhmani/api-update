/**
 * Legacy Kite browser session helpers.
 *
 * Broker access tokens must NEVER be stored in sessionStorage/localStorage.
 * These helpers only clear obsolete keys and expose non-secret connection status
 * via server APIs.
 */

const LEGACY_SESSION_KEY = 'quantorus:kite-session';

/** Remove any historically stored Kite token material from browser storage. */
export function clearKiteSession(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(LEGACY_SESSION_KEY);
    window.localStorage.removeItem(LEGACY_SESSION_KEY);
  } catch {
    // ignore quota / private mode errors
  }
}

/**
 * @deprecated Tokens are server-side only. Always returns null.
 */
export function getKiteSession(): null {
  clearKiteSession();
  return null;
}

/**
 * @deprecated Tokens are server-side only. No-ops after clearing legacy keys.
 */
export function saveKiteSession(_session: unknown): void {
  clearKiteSession();
}

/**
 * @deprecated Use server-side /api/kite/profile (cookie session).
 */
export function getKiteAccessToken(): null {
  clearKiteSession();
  return null;
}
