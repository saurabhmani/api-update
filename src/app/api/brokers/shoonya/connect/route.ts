import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { shoonyaBrokerAdapter } from '@/lib/broker/oauth/shoonyaAdapter';
import { ShoonyaConfigError } from '@/lib/broker/oauth/shoonya';
import {
  dataSourceErrorRedirect,
  redirectToAppPath,
} from '@/lib/broker/oauth/appRedirects';

export const dynamic = 'force-dynamic';

function redirectWithNoStore(url: string): NextResponse {
  const response = NextResponse.redirect(url, 302);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

/** GET /api/brokers/shoonya/connect — begin Shoonya OAuth for the signed-in user */
export async function GET(request: NextRequest) {
  try {
    const user = await requireSession();
    const url = await shoonyaBrokerAdapter.getAuthorizationUrl(user.id);
    return redirectWithNoStore(url);
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { ok: false, error: 'Unauthorized' },
        { status: 401, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    if (err instanceof ShoonyaConfigError) {
      return dataSourceErrorRedirect(request, 'shoonya', 'not_configured');
    }
    return dataSourceErrorRedirect(request, 'shoonya', 'authentication_failed');
  }
}
