import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  isKiteInvalidToken,
  kiteAuthenticatedRequest,
  KiteApiError,
  type KiteApiResponse,
} from '@/lib/kite/api-client';
import {
  clearActiveKiteSession,
  getActiveKiteSession,
} from '@/lib/kite/active-session-store';
import { getKiteClient, resetKiteClient } from '@/lib/kite/client';
import {
  getDecryptedAccessTokenForUser,
  markBrokerConnectionStatus,
} from '@/lib/broker/connections';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

function invalidateSuccess(): NextResponse {
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}

function isIdempotentInvalidation(response: KiteApiResponse): boolean {
  return isKiteInvalidToken(response) || response.httpStatus === 404;
}

/**
 * POST /api/kite/session — browser token handoff is removed.
 * Clients must complete OAuth via /api/kite/auth/*; tokens stay server-side.
 */
export async function POST(_request: NextRequest) {
  try {
    await requireSession();
    return jsonError(
      'Browser Kite token handoff is disabled. Complete OAuth via /api/kite/auth/start.',
      410,
    );
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return jsonError('Unauthorized', 401);
    }
    return jsonError('Unable to register Kite session', 500);
  }
}

/**
 * DELETE /api/kite/session — revoke server-side Kite session for the authenticated user.
 * Does not accept browser-supplied Bearer tokens.
 */
export async function DELETE(_request: NextRequest) {
  try {
    const user = await requireSession();
    const quantorusUserId = String(user.id);

    const active = await getActiveKiteSession().catch(() => null);
    let accessToken: string | null = null;

    if (active && active.quantorusUserId === quantorusUserId) {
      accessToken = active.accessToken;
    } else {
      accessToken = await getDecryptedAccessTokenForUser(user.id, 'zerodha');
    }

    if (!accessToken) {
      // Already disconnected — idempotent success.
      await clearActiveKiteSession().catch(() => undefined);
      try {
        resetKiteClient();
      } catch {
        // ignore
      }
      await markBrokerConnectionStatus(user.id, 'zerodha', 'disconnected', true).catch(
        () => undefined,
      );
      return invalidateSuccess();
    }

    const response = await kiteAuthenticatedRequest({
      method: 'DELETE',
      path: '/session/token',
      accessToken,
      credentialMode: 'form',
    });

    if (
      (response.httpStatus >= 200 && response.httpStatus < 300)
      || isIdempotentInvalidation(response)
    ) {
      await clearActiveKiteSession(accessToken).catch(() => undefined);
      try {
        if (getKiteClient().getAccessToken() === accessToken) {
          resetKiteClient();
        }
      } catch {
        // Client may be unconfigured (missing env) even when remote revoke succeeded.
      }
      await markBrokerConnectionStatus(user.id, 'zerodha', 'disconnected', true).catch(
        () => undefined,
      );
      return invalidateSuccess();
    }

    return jsonError('Kite session invalidation failed', 502);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return jsonError('Unauthorized', 401);
    }

    if (err instanceof KiteApiError) {
      if (err.classification === 'configuration') {
        return jsonError('Kite is not configured', 503);
      }
      if (err.classification === 'network' || err.classification === 'invalid_response') {
        return jsonError(
          err.classification === 'network'
            ? 'Unable to reach Kite API'
            : 'Invalid response from Kite API',
          502,
        );
      }
    }

    return jsonError('Unable to invalidate Kite session', 500);
  }
}
