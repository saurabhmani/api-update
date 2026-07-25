import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { consumeKiteAuthState } from '@/lib/kite/auth-state';
import { createKiteSession, KiteSessionError } from '@/lib/kite/create-session';
import { createKiteCompletionCode } from '@/lib/kite/completion-store';
import {
  buildAuthCompleteRedirectUrl,
  isLoopbackOrigin,
  resolveAuthCompleteOrigin,
} from '@/lib/kite/auth-complete-fragment';
import { getKiteClient } from '@/lib/kite/client';
import { saveActiveKiteSession } from '@/lib/kite/active-session-store';
import { persistZerodhaBrokerConnection } from '@/lib/broker/oauth/zerodhaBridge';
import { redirectToAppPath } from '@/lib/broker/oauth/appRedirects';
import {
  buildKiteRedirectMismatchUrl,
  getConfiguredKiteRedirectOrigin,
  isKiteCallbackOnWrongLoopbackHost,
} from '@/lib/kite/redirect-host';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function redirectWithNoStore(url: string): NextResponse {
  const response = NextResponse.redirect(url, 302);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function dataSourceError(request: NextRequest, error: string): NextResponse {
  // Prefer same-host redirect so local/dev never bounce to a stale APP_URL.
  return redirectToAppPath(request, '/data-source', {
    broker: 'zerodha',
    error,
  });
}

/** GET /api/kite/auth/callback — complete Zerodha Kite Connect login for the signed-in user */
export async function GET(request: NextRequest) {
  // Zerodha sent the browser to localhost while the server expects a public
  // callback host. Do not consume state/token here — send the user back with
  // a clear config error so a manual host edit is not required.
  if (isKiteCallbackOnWrongLoopbackHost(request)) {
    const publicOrigin = getConfiguredKiteRedirectOrigin();
    if (publicOrigin) {
      console.error('[kite/callback] Zerodha redirected to loopback; KITE_REDIRECT_URL is public', {
        requestHost: request.nextUrl.host,
        expectedOrigin: publicOrigin,
      });
      return redirectWithNoStore(buildKiteRedirectMismatchUrl(publicOrigin));
    }
  }

  const origin = resolveAuthCompleteOrigin(request.nextUrl.origin, {
    headers: request.headers,
  });

  try {
    const user = await requireSession();
    const quantorusUserId = String(user.id);

    const { searchParams } = request.nextUrl;
    const status = (searchParams.get('status') ?? '').trim().toLowerCase();
    const requestToken = searchParams.get('request_token')?.trim() ?? '';
    const state = searchParams.get('state')?.trim() ?? '';

    if (status === 'cancelled' || status === 'cancel' || status === 'denied') {
      return dataSourceError(request, 'cancelled');
    }

    if (status && status !== 'success') {
      console.error('[kite/callback] non-success status', { status });
      return dataSourceError(request, 'authentication_failed');
    }

    if (!requestToken || !state) {
      console.error('[kite/callback] missing request_token or state', {
        hasToken: Boolean(requestToken),
        hasState: Boolean(state),
        status: status || null,
      });
      return dataSourceError(request, 'oauth_incomplete');
    }

    if (!(await consumeKiteAuthState(state, quantorusUserId))) {
      return dataSourceError(request, 'invalid_state');
    }

    let session;
    try {
      session = await createKiteSession(requestToken);
    } catch (exchangeErr) {
      const kiteErr = exchangeErr instanceof KiteSessionError ? exchangeErr : null;
      console.error('[kite/callback] token exchange failed', {
        errorType: kiteErr?.errorType ?? (exchangeErr instanceof Error ? exchangeErr.name : 'unknown'),
        status: kiteErr?.status ?? null,
      });
      return dataSourceError(request, 'kite_token_exchange');
    }

    const authenticatedAt = new Date().toISOString();

    // Persist THIS user's Redis session. System feed keys update only when
    // userId === SYSTEM_MARKET_DATA_USER_ID (see saveUserKiteSession).
    try {
      await saveActiveKiteSession({
        accessToken: session.accessToken,
        kiteUserId: session.userId,
        quantorusUserId,
        authenticatedAt,
      });
      const { shouldUpdateSystemKiteFeed } = await import(
        '@/lib/marketData/connectionManager'
      );
      if (shouldUpdateSystemKiteFeed(user.id)) {
        getKiteClient().setAccessToken(session.accessToken);
      }
    } catch {
      // Non-fatal — broker_connections is the durable source of truth.
    }

    // Durable per-user broker_connections row (encrypted token + expiry).
    try {
      await persistZerodhaBrokerConnection({
        userId: user.id,
        accessToken: session.accessToken,
        kiteUserId: session.userId,
        userName: session.userName ?? null,
        authenticatedAt,
      });
      console.log('[kite/callback] broker_connection_saved', {
        userId: user.id,
        broker: 'zerodha',
      });
    } catch (persistErr) {
      console.error('[kite/callback] failed to persist broker connection', {
        reason: persistErr instanceof Error ? persistErr.name : 'unknown',
      });
      return dataSourceError(request, 'persistence_failed');
    }

    // Activate process-global live feed now that a token exists (boot often
    // started the ticker without credentials and left it closed).
    try {
      const { ensureStreamingAfterBrokerConnect } = await import(
        '@/lib/marketData/ensureBrokerStreaming'
      );
      const stream = await ensureStreamingAfterBrokerConnect({
        userId: user.id,
        broker: 'zerodha',
        accessToken: session.accessToken,
      });
      console.log('[kite/callback] market_data_start_requested', {
        userId: user.id,
        ok: stream.ok,
        tickerReconnected: stream.tickerReconnected,
        wsRunning: stream.wsRunning,
        baselineSymbols: stream.baselineSymbols,
      });
    } catch (streamErr) {
      console.error('[kite/callback] market_data_stream_failed', {
        reason: streamErr instanceof Error ? streamErr.name : 'unknown',
      });
    }

    // Opaque completion handoff is UX-only (tokens already server-side).
    // Never fail the login if Redis completion minting fails.
    try {
      const code = await createKiteCompletionCode({
        quantorusUserId,
        kiteUserId: session.userId,
        authenticatedAt,
      });
      return redirectWithNoStore(buildAuthCompleteRedirectUrl(origin, code));
    } catch (completionErr) {
      console.error('[kite/callback] completion code unavailable; redirecting to dashboard', {
        reason: completionErr instanceof Error ? completionErr.name : 'unknown',
      });
      return redirectToAppPath(request, '/data-source', {
        connected: '1',
        broker: 'zerodha',
      });
    }
  } catch (err) {
    if (err instanceof AuthenticationError) {
      // Cookie lost across the Zerodha redirect — often because Zerodha returned
      // to localhost while the app expects dig/prod (no session cookie on loopback).
      const configuredOrigin = getConfiguredKiteRedirectOrigin();
      if (
        configuredOrigin
        && !isLoopbackOrigin(configuredOrigin)
        && (request.nextUrl.hostname === 'localhost'
          || request.nextUrl.hostname === '127.0.0.1')
      ) {
        return redirectWithNoStore(buildKiteRedirectMismatchUrl(configuredOrigin));
      }
      return redirectToAppPath(request, '/login', {
        from: '/data-source?broker=zerodha&reason=reconnect',
      });
    }

    console.error('[kite/callback] unexpected failure', {
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return dataSourceError(request, 'authentication_failed');
  }
}
