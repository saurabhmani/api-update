'use client';

export const REMOTE_INVALIDATION_WARNING =
  'Your local Zerodha session was removed, but remote invalidation could not be confirmed. Reconnect if you use another device.';

export async function invalidateRemoteKiteSession(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch('/api/kite/session', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      credentials: 'same-origin',
      cache: 'no-store',
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
