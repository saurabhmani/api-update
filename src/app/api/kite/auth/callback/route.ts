import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { consumeKiteAuthState } from '@/lib/kite/auth-state';
import { createKiteSession, KiteSessionError } from '@/lib/kite/create-session';
import { createKiteCompletionCode } from '@/lib/kite/completion-store';
import {
  buildAuthCompleteRedirectUrl,
  resolveAuthCompleteOrigin,
} from '@/lib/kite/auth-complete-fragment';
import { getKiteClient } from '@/lib/kite/client';
import { saveActiveKiteSession } from '@/lib/kite/active-session-store';
import { persistZerodhaBrokerConnection } from '@/lib/broker/oauth/zerodhaBridge';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status, headers: NO_STORE });
}

function redirectWithNoStore(url: string): NextResponse {
  const response = NextResponse.redirect(url, 302);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function dataSourceErrorRedirect(origin: string, error: string): NextResponse {
  return redirectWithNoStore(
    `${origin}/data-source?broker=zerodha&error=${encodeURIComponent(error)}`,
  );
}

/** GET /api/kite/auth/callback — complete Zerodha Kite Connect login for the signed-in user */
export async function GET(request: NextRequest) {
  const origin = resolveAuthCompleteOrigin(request.nextUrl.origin, {
    headers: request.headers,
  });

  try {
    const user = await requireSession();
    const quantorusUserId = String(user.id);

    const { searchParams } = request.nextUrl;
    const status = searchParams.get('status');
    const requestToken = searchParams.get('request_token')?.trim() ?? '';
    const state = searchParams.get('state')?.trim() ?? '';

    if (status !== 'success' || !requestToken || !state) {
      return dataSourceErrorRedirect(origin, 'authentication_failed');
    }

    if (!(await consumeKiteAuthState(state, quantorusUserId))) {
      return dataSourceErrorRedirect(origin, 'invalid_state');
    }

    const session = await createKiteSession(requestToken);
    const authenticatedAt = new Date().toISOString();

    // Persist session for market-data / CLI (not KITE_ACCESS_TOKEN env),
    // and apply to this process's singleton client.
    try {
      await saveActiveKiteSession({
        accessToken: session.accessToken,
        kiteUserId: session.userId,
        quantorusUserId,
        authenticatedAt,
      });
      getKiteClient().setAccessToken(session.accessToken);
    } catch {
      // Non-fatal for browser handoff; market APIs need Redis + reconnect if this fails.
    }

    // Durable per-user broker_connections row (encrypted token at rest).
    // Failure here must not present a successful dashboard handoff — the
    // dashboard gate requires broker_connections.
    try {
      await persistZerodhaBrokerConnection({
        userId: user.id,
        accessToken: session.accessToken,
        kiteUserId: session.userId,
        userName: session.userName ?? null,
        authenticatedAt,
      });
    } catch (persistErr) {
      console.error('[kite/callback] failed to persist broker connection', {
        reason: persistErr instanceof Error ? persistErr.name : 'unknown',
      });
      return dataSourceErrorRedirect(origin, 'persistence_failed');
    }

    const code = await createKiteCompletionCode({
      quantorusUserId,
      kiteUserId: session.userId,
      authenticatedAt,
    });

    return redirectWithNoStore(buildAuthCompleteRedirectUrl(origin, code));
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return jsonError('Unauthorized', 401);
    }

    if (err instanceof KiteSessionError) {
      return dataSourceErrorRedirect(origin, 'authentication_failed');
    }

    return dataSourceErrorRedirect(origin, 'authentication_failed');
  }
}
