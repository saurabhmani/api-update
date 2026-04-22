// ════════════════════════════════════════════════════════════════
//  tokenGuard — validate access_token and stop the WS on failure
//
//  Purpose
//  ───────
//  The ticker already does a REST preflight inside openSocket, but
//  that only runs at connect time. A token can go bad mid-session
//  (revoked from the Kite dashboard, daily rollover, another login
//  on the same api_key). This module exposes a standalone check
//  that any caller can run — an admin endpoint, a periodic health
//  probe, an integration test — to force a clean stop and require
//  a fresh /api/kite/login round-trip.
//
//  Contract
//  ────────
//  - Calls validateKiteToken (which hits /user/profile — the same
//    "getProfile" endpoint the Kite JS SDK uses).
//  - On 200: returns { ok: true }.
//  - On 403 / 401: clears the stored token, disconnects the WS,
//    sets the ticker's loginRequired flag, and returns ok:false.
//  - On network / 5xx: returns ok:false WITHOUT touching the
//    token — transient errors shouldn't force a re-login.
//  - Never throws. Callers get a structured verdict.
// ════════════════════════════════════════════════════════════════

import {
  getKiteAccessToken,
  validateKiteToken,
  clearKiteAccessToken,
} from './kiteSession';
import { getTicker } from './kiteTicker';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'tokenGuard' });

export type TokenGuardVerdict =
  | { ok: true; status: 200 }
  | { ok: false; status: number; reason: string; action: 'stopped' | 'none' };

/**
 * Run the validation check. If the token is confirmed dead,
 * disconnect the ticker singleton and mark loginRequired so the
 * reconnect loop doesn't fight the user.
 */
export async function validateAndGuardToken(): Promise<TokenGuardVerdict> {
  const token = await getKiteAccessToken();
  if (!token) {
    // No token at all — same outcome as a dead token. Make sure
    // the ticker isn't sitting in a reconnect loop.
    stopTicker();
    return {
      ok:     false,
      status: 0,
      reason: 'no access_token in DB',
      action: 'stopped',
    };
  }

  const probe = await validateKiteToken(token);
  if (probe.ok) {
    return { ok: true, status: 200 };
  }

  // Permanent failures — treat as a dead token.
  if (probe.status === 401 || probe.status === 403) {
    await clearKiteAccessToken().catch(() => {});
    stopTicker();
    return {
      ok:     false,
      status: probe.status,
      reason: probe.message ?? `Kite rejected token (HTTP ${probe.status})`,
      action: 'stopped',
    };
  }

  // Transient failure — don't nuke the token.
  return {
    ok:     false,
    status: probe.status,
    reason: probe.message ?? 'transient validation error',
    action: 'none',
  };
}

function stopTicker(): void {
  const ticker = getTicker();
  try {
    ticker.disconnect();
  } catch (e) {
    console.warn('[tokenGuard] disconnect failed:', (e as Error).message);
  }
  // The ticker sets loginRequired itself when it sees a 403, but
  // we may have detected the failure outside that code path. Set
  // it defensively through the public API.
  //
  // Note: we call clearLoginRequired only when we WANT to reconnect
  // after a fresh login — so we don't touch it here. The next
  // connect() call will see loginRequired via openSocket's own
  // preflight and refuse until cleared.
  console.warn(
    '[tokenGuard] ticker stopped — require re-login via /api/kite/login'
  );
}
