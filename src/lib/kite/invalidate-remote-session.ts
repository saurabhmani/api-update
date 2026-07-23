'use client';

export const REMOTE_INVALIDATION_WARNING =
  'Your local Zerodha session was removed, but remote invalidation could not be confirmed. Reconnect if you use another device.';

/**
 * Invalidate the server-side Kite session using the authenticated Quant cookie.
 * Never sends a broker access token from the browser.
 */
export async function invalidateRemoteKiteSession(): Promise<boolean> {
  try {
    const response = await fetch('/api/brokers/zerodha/disconnect', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function shouldApplyVerificationResult(
  requestGeneration: number,
  currentGeneration: number,
): boolean {
  return requestGeneration === currentGeneration;
}

export function localDisconnectState(
  remoteInvalidationConfirmed: boolean,
): { status: 'not_connected'; remoteInvalidationWarning?: string } {
  if (remoteInvalidationConfirmed) {
    return { status: 'not_connected' };
  }
  return {
    status: 'not_connected',
    remoteInvalidationWarning: REMOTE_INVALIDATION_WARNING,
  };
}
