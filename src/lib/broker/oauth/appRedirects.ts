/**
 * Same-host redirects for in-app pages (data-source, dashboard, login).
 *
 * Never use APP_BASE_URL for these — a mis-set production URL during local/dev
 * (or a partial deploy) sends users to a host that may not have the route yet.
 * OAuth callback URLs registered with brokers still use resolveAppBaseUrl().
 */

import { NextRequest, NextResponse } from 'next/server';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export function redirectToAppPath(
  request: NextRequest,
  pathname: string,
  query?: Record<string, string | null | undefined>,
): NextResponse {
  const url = new URL(pathname, request.url);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') continue;
      url.searchParams.set(key, value);
    }
  }
  const response = NextResponse.redirect(url, 302);
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export function dataSourceErrorRedirect(
  request: NextRequest,
  broker: 'zerodha' | 'shoonya',
  error: string,
): NextResponse {
  return redirectToAppPath(request, '/data-source', { broker, error });
}
