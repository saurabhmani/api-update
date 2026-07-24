import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { createBrokerAuthTransaction } from '@/lib/broker/connections';
import { getKiteConfig } from '@/lib/kite/config';
import { createKiteAuthState } from '@/lib/kite/auth-state';
import { KiteConfigError } from '@/lib/kite/errors';
import { dataSourceErrorRedirect } from '@/lib/broker/oauth/appRedirects';
import { isKiteRedirectHostMismatch } from '@/lib/kite/redirect-host';

export const dynamic = 'force-dynamic';

const KITE_LOGIN_BASE = 'https://kite.zerodha.com/connect/login';

function kiteLoginUrl(apiKey: string, state: string): string {
  const params = new URLSearchParams({
    v: '3',
    api_key: apiKey,
    redirect_params: `state=${state}`,
  });
  return `${KITE_LOGIN_BASE}?${params.toString()}`;
}

function redirectWithNoStore(url: string): NextResponse {
  const response = NextResponse.redirect(url, 302);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/**
 * GET /api/brokers/zerodha/connect
 * Reuses the existing Kite Connect login flow (same as /api/kite/auth/start).
 */
export async function GET(request: NextRequest) {
  try {
    const user = await requireSession();
    const quantorusUserId = String(user.id);

    // Zerodha always returns to the Redirect URL on developers.kite.trade.
    // If that env still points at localhost while the user is on dig/prod,
    // fail closed before sending them into a broken OAuth round-trip.
    if (isKiteRedirectHostMismatch(request)) {
      return dataSourceErrorRedirect(request, 'zerodha', 'redirect_url_mismatch');
    }

    // Best-effort durable TX row — Redis CSRF state is what the callback needs.
    try {
      await createBrokerAuthTransaction({
        userId: user.id,
        broker: 'zerodha',
        state: null,
      });
    } catch (txErr) {
      console.error('[zerodha/connect] broker_auth_transactions unavailable', {
        reason: txErr instanceof Error ? txErr.name : 'unknown',
      });
    }

    const { apiKey } = getKiteConfig();
    const state = await createKiteAuthState(quantorusUserId);
    return redirectWithNoStore(kiteLoginUrl(apiKey, state));
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    if (err instanceof KiteConfigError) {
      return dataSourceErrorRedirect(request, 'zerodha', 'not_configured');
    }

    if (err instanceof Error && err.message === 'Kite auth state store unavailable') {
      return dataSourceErrorRedirect(request, 'zerodha', 'redis_unavailable');
    }

    console.error('[zerodha/connect] failed to start OAuth', {
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return dataSourceErrorRedirect(request, 'zerodha', 'authentication_failed');
  }
}
