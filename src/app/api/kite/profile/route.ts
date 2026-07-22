import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  isKiteInvalidToken,
  kiteAuthenticatedRequest,
  KiteApiError,
} from '@/lib/kite/api-client';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export interface KiteProfileResponse {
  userId: string;
  userName: string;
  email: string;
  broker: string;
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

function parseBearerAccessToken(request: NextRequest): string | null {
  const header = request.headers.get('authorization');
  if (!header) return null;

  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  if (!match) return null;

  const token = match[1].trim();
  return token.length > 0 ? token : null;
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

/** GET /api/kite/profile — verify a browser-held Kite access token against Zerodha */
export async function GET(request: NextRequest) {
  try {
    await requireSession();

    const accessToken = parseBearerAccessToken(request);
    if (!accessToken) {
      return jsonError('Kite access token is required', 401);
    }

    const response = await kiteAuthenticatedRequest({
      method: 'GET',
      path: '/user/profile',
      accessToken,
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

    return NextResponse.json(profile, { status: 200, headers: NO_STORE });
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
