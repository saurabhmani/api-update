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
  saveActiveKiteSession,
} from '@/lib/kite/active-session-store';
import { getKiteClient, resetKiteClient } from '@/lib/kite/client';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

function invalidateSuccess(): NextResponse {
  return new NextResponse(null, { status: 204, headers: NO_STORE });
}

function parseBearerAccessToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return null;

  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function isIdempotentInvalidation(response: KiteApiResponse): boolean {
  return isKiteInvalidToken(response) || response.httpStatus === 404;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseKiteProfile(body: unknown): { userId: string } | null {
  if (!isRecord(body) || body.status !== 'success' || !isRecord(body.data)) {
    return null;
  }
  const userId = readNonEmptyString(body.data.user_id);
  if (!userId) return null;
  return { userId };
}

/**
 * POST /api/kite/session — register browser session token as the server
 * active session (Redis + in-process client). Used after OAuth and to
 * re-sync if Redis was cleared while sessionStorage still holds the token.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireSession();
    const accessToken = parseBearerAccessToken(request);
    if (!accessToken) {
      return jsonError('Kite access token is required', 401);
    }

    const response = await kiteAuthenticatedRequest({
      method: 'GET',
      path: '/user/profile',
      accessToken,
    });

    if (
      response.empty
      || response.httpStatus < 200
      || response.httpStatus >= 300
      || response.kiteStatus === 'error'
    ) {
      if (isKiteInvalidToken(response)) {
        return jsonError('Invalid or expired Kite access token', 401);
      }
      return jsonError('Unable to verify Kite session', 502);
    }

    const profile = parseKiteProfile(response.body);
    if (!profile) {
      return jsonError('Invalid response from Kite API', 502);
    }

    const authenticatedAt = new Date().toISOString();
    await saveActiveKiteSession({
      accessToken,
      kiteUserId: profile.userId,
      quantorusUserId: String(user.id),
      authenticatedAt,
    });
    getKiteClient().setAccessToken(accessToken);

    return NextResponse.json(
      { ok: true, kiteUserId: profile.userId, authenticatedAt },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return jsonError('Unauthorized', 401);
    }

    if (err instanceof KiteApiError) {
      if (err.classification === 'configuration') {
        return jsonError('Kite is not configured', 503);
      }
      if (err.classification === 'network' || err.classification === 'invalid_response') {
        return jsonError(err.message, 502);
      }
    }

    return jsonError('Unable to register Kite session', 500);
  }
}

/** DELETE /api/kite/session — invalidate a browser-held Kite access token */
export async function DELETE(request: NextRequest) {
  try {
    await requireSession();

    const accessToken = parseBearerAccessToken(request);
    if (!accessToken) {
      return jsonError('Kite access token is required', 401);
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
      await clearActiveKiteSession(accessToken);
      if (getKiteClient().getAccessToken() === accessToken) {
        resetKiteClient();
      }
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
