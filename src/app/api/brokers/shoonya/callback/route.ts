import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { shoonyaBrokerAdapter } from '@/lib/broker/oauth/shoonyaAdapter';
import {
  dataSourceErrorRedirect,
  redirectToAppPath,
} from '@/lib/broker/oauth/appRedirects';

export const dynamic = 'force-dynamic';

/** GET /api/brokers/shoonya/callback — complete Shoonya OAuth */
export async function GET(request: NextRequest) {
  try {
    const user = await requireSession();
    const { searchParams } = request.nextUrl;

    // Primary: `code`. Explicitly supported aliases only (no request_token).
    const code =
      searchParams.get('code')
      || searchParams.get('auth_code')
      || searchParams.get('AuthCode');
    const state = searchParams.get('state');
    const errorParam = searchParams.get('error') || searchParams.get('status');

    if (errorParam && /cancel|denied|access_denied/i.test(errorParam)) {
      return dataSourceErrorRedirect(request, 'shoonya', 'cancelled');
    }

    if (!code) {
      return dataSourceErrorRedirect(request, 'shoonya', 'missing_code');
    }

    const result = await shoonyaBrokerAdapter.handleCallback(user.id, {
      code,
      auth_code: searchParams.get('auth_code'),
      AuthCode: searchParams.get('AuthCode'),
      state,
    });

    if (!result.ok) {
      return dataSourceErrorRedirect(
        request,
        'shoonya',
        result.errorCode ?? 'authentication_failed',
      );
    }

    return redirectToAppPath(request, '/dashboard');
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return redirectToAppPath(request, '/login', { from: '/data-source' });
    }

    // Sanitized log — never include code, checksum, or tokens
    console.error('[shoonya/callback] authentication failed', {
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return dataSourceErrorRedirect(request, 'shoonya', 'authentication_failed');
  }
}
