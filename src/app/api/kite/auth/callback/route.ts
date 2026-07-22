import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { consumeKiteAuthState } from '@/lib/kite/auth-state';
import { createKiteSession, KiteSessionError } from '@/lib/kite/create-session';
import { createKiteCompletionCode } from '@/lib/kite/completion-store';
import { buildAuthCompleteRedirectUrl } from '@/lib/kite/auth-complete-fragment';
import { getKiteClient } from '@/lib/kite/client';
import { saveActiveKiteSession } from '@/lib/kite/active-session-store';

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

/** GET /api/kite/auth/callback — complete Zerodha Kite Connect login for the signed-in user */
export async function GET(request: NextRequest) {
  try {
    const user = await requireSession();
    const quantorusUserId = String(user.id);

    const { searchParams } = request.nextUrl;
    const status = searchParams.get('status');
    const requestToken = searchParams.get('request_token')?.trim() ?? '';
    const state = searchParams.get('state')?.trim() ?? '';

    if (status !== 'success' || !requestToken || !state) {
      return jsonError('Invalid Kite authentication callback', 400);
    }

    if (!(await consumeKiteAuthState(state, quantorusUserId))) {
      return jsonError('Invalid or expired authentication state', 401);
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

    const code = await createKiteCompletionCode({
      quantorusUserId,
      kiteUserId: session.userId,
      accessToken: session.accessToken,
    });

    return redirectWithNoStore(buildAuthCompleteRedirectUrl(request.nextUrl.origin, code));
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return jsonError('Unauthorized', 401);
    }

    if (err instanceof KiteSessionError) {
      const status = err.status >= 400 && err.status < 600 ? err.status : 502;
      return jsonError('Kite session exchange failed', status);
    }

    return jsonError('Unable to complete Kite authentication', 500);
  }
}
