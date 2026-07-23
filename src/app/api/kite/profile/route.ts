import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  isKiteInvalidToken,
  kiteAuthenticatedRequest,
  KiteApiError,
} from '@/lib/kite/api-client';
import { getActiveKiteSession } from '@/lib/kite/active-session-store';
import { getDecryptedAccessTokenForUser } from '@/lib/broker/connections';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export interface KiteProfileResponse {
  userId: string;
  userName: string;
  email: string;
  broker: string;
  kiteUserId?: string;
  authenticatedAt?: string;
}

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseKiteProfile(body: unknown): KiteProfileResponse | null {
  if (!isRecord(body) || body.status !== 'success' || !isRecord(body.data)) {
    return null;
  }

  const userId = readNonEmptyString(body.data.user_id);
  const userName = readNonEmptyString(body.data.user_name);
  const email = readNonEmptyString(body.data.email);
  const broker = readNonEmptyString(body.data.broker);

  if (!userId || !userName || !email || !broker) {
    return null;
  }

  return { userId, userName, email, broker };
}

/**
 * Resolve the server-side Kite access token for the authenticated Quant user.
 * Never accepts browser-supplied Bearer tokens.
 */
async function resolveServerAccessToken(userId: number): Promise<{
  accessToken: string;
  kiteUserId?: string;
  authenticatedAt?: string;
} | null> {
  const active = await getActiveKiteSession().catch(() => null);
  if (
    active
    && active.quantorusUserId === String(userId)
    && active.accessToken.trim()
  ) {
    return {
      accessToken: active.accessToken,
      kiteUserId: active.kiteUserId,
      authenticatedAt: active.authenticatedAt,
    };
  }

  const decrypted = await getDecryptedAccessTokenForUser(userId, 'zerodha');
  if (!decrypted) return null;
  return { accessToken: decrypted };
}

/** GET /api/kite/profile — verify server-side Kite credentials against Zerodha */
export async function GET(_request: NextRequest) {
  try {
    const user = await requireSession();
    const resolved = await resolveServerAccessToken(user.id);
    if (!resolved) {
      return jsonError('Kite is not connected', 401);
    }

    const response = await kiteAuthenticatedRequest({
      method: 'GET',
      path: '/user/profile',
      accessToken: resolved.accessToken,
    });

    if (response.empty) {
      return jsonError('Empty response from Kite API', 502);
    }

    if (
      response.httpStatus < 200
      || response.httpStatus >= 300
      || response.kiteStatus === 'error'
    ) {
      if (isKiteInvalidToken(response)) {
        return jsonError('Invalid or expired Kite access token', 401);
      }
      return jsonError('Kite profile request failed', 502);
    }

    const profile = parseKiteProfile(response.body);
    if (!profile) {
      return jsonError('Invalid response from Kite API', 502);
    }

    return NextResponse.json(
      {
        ...profile,
        kiteUserId: resolved.kiteUserId ?? profile.userId,
        authenticatedAt: resolved.authenticatedAt,
      },
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

    return jsonError('Unable to fetch Kite profile', 500);
  }
}
