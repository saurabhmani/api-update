import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
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

/** GET /api/kite/auth/start — begin Zerodha Kite Connect login for the signed-in user */
export async function GET(request?: NextRequest) {
  try {
    const user = await requireSession();
    const quantorusUserId = String(user.id);

    if (request && isKiteRedirectHostMismatch(request)) {
      return dataSourceErrorRedirect(request, 'zerodha', 'redirect_url_mismatch');
    }

    const { apiKey } = getKiteConfig();
    const state = await createKiteAuthState(quantorusUserId);
    const loginUrl = kiteLoginUrl(apiKey, state);

    return redirectWithNoStore(loginUrl);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    if (err instanceof KiteConfigError) {
      return NextResponse.json(
        { ok: false, error: 'Kite is not configured' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    if (err instanceof Error && err.message === 'Kite auth state store unavailable') {
      return NextResponse.json(
        { ok: false, error: 'Kite authentication temporarily unavailable' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    return NextResponse.json(
      { ok: false, error: 'Unable to start Kite authentication' },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
