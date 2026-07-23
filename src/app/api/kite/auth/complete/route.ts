import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { consumeKiteCompletionCode } from '@/lib/kite/completion-store';
import { getActiveKiteSession } from '@/lib/kite/active-session-store';
import { getBrokerConnectionByUserAndBroker } from '@/lib/broker/connections';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

/**
 * POST /api/kite/auth/complete — redeem a one-time opaque completion code.
 * Never returns access tokens to the browser.
 */
export async function POST(request: NextRequest) {
  try {
    const user = await requireSession();
    const quantorusUserId = String(user.id);

    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return jsonError('Invalid request body', 400);
    }

    const code = (body as { code?: unknown }).code;
    if (typeof code !== 'string' || !code.trim()) {
      return jsonError('code is required', 400);
    }

    const session = await consumeKiteCompletionCode(code.trim(), quantorusUserId);
    if (!session) {
      return jsonError('Invalid or expired completion code', 401);
    }

    // Confirm server-side credentials exist (Redis and/or broker_connections).
    const [active, connection] = await Promise.all([
      getActiveKiteSession().catch(() => null),
      getBrokerConnectionByUserAndBroker(user.id, 'zerodha').catch(() => null),
    ]);

    const redisOk = Boolean(
      active
      && active.quantorusUserId === quantorusUserId
      && active.kiteUserId === session.kiteUserId,
    );
    const dbOk = Boolean(
      connection
      && connection.status === 'active'
      && connection.accessTokenEncrypted,
    );

    if (!redisOk && !dbOk) {
      return jsonError('Broker connection is not available. Please reconnect.', 409);
    }

    return NextResponse.json(
      {
        ok: true,
        kiteUserId: session.kiteUserId,
        authenticatedAt: session.authenticatedAt,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return jsonError('Unauthorized', 401);
    }

    return jsonError('Unable to complete Kite authentication', 500);
  }
}
