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
      console.log('[shoonya/callback] auth failed — redirecting to data-source', {
        userId: user.id,
        errorCode: result.errorCode ?? 'authentication_failed',
      });
      return dataSourceErrorRedirect(
        request,
        'shoonya',
        result.errorCode ?? 'authentication_failed',
      );
    }

    console.log('[shoonya/callback] broker_connection_saved', {
      userId: user.id,
      broker: 'shoonya',
    });

    // Ensure live stack / poll baseline. Live WS ticks remain Kite/Yahoo
    // (getLiveFeedProvider); Shoonya does not open a second ticker.
    try {
      const { ensureStreamingAfterBrokerConnect } = await import(
        '@/lib/marketData/ensureBrokerStreaming'
      );
      const stream = await ensureStreamingAfterBrokerConnect({
        userId: user.id,
        broker: 'shoonya',
      });
      console.log('[shoonya/callback] market_data_start_requested', {
        userId: user.id,
        ok: stream.ok,
        provider: stream.provider,
        wsRunning: stream.wsRunning,
        baselineSymbols: stream.baselineSymbols,
      });
    } catch (streamErr) {
      console.error('[shoonya/callback] market_data_stream_failed', {
        reason: streamErr instanceof Error ? streamErr.name : 'unknown',
      });
    }

    console.log('[shoonya/callback] auth ok — redirecting to data-source', {
      userId: user.id,
      requestHost: request.headers.get('host'),
      xForwardedHost: request.headers.get('x-forwarded-host'),
      nextOrigin: request.nextUrl.origin,
    });
    return redirectToAppPath(request, '/dashboard');
  } catch (err) {
    if (err instanceof AuthenticationError) {
      console.log('[shoonya/callback] no session — redirecting to login');
      return redirectToAppPath(request, '/login', { from: '/data-source' });
    }

    // Sanitized log — never include code, checksum, or tokens
    console.error('[shoonya/callback] authentication failed', {
      reason: err instanceof Error ? err.name : 'unknown',
    });
    return dataSourceErrorRedirect(request, 'shoonya', 'authentication_failed');
  }
}
