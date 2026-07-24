/**
 * Same-host redirects for in-app pages (data-source, dashboard, login).
 *
 * Prefer the live request host, but never emit https://localhost — local
 * `next start` has no TLS, and browsers with cached HSTS then show
 * ERR_SSL_PROTOCOL_ERROR after OAuth.
 */

import { NextRequest, NextResponse } from 'next/server';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || host.endsWith('.localhost')
  );
}

function configuredLoopbackOrigin(): string | null {
  for (const key of ['APP_BASE_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL'] as const) {
    const raw = (process.env[key] ?? '').trim();
    if (!raw) continue;
    try {
      const url = new URL(raw);
      if (isLoopbackHostname(url.hostname)) {
        url.protocol = 'http:';
        url.pathname = '';
        url.search = '';
        url.hash = '';
        return url.origin;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/** Build an in-app absolute URL that stays on http for loopback hosts. */
export function appPathUrl(
  request: NextRequest,
  pathname: string,
  query?: Record<string, string | null | undefined>,
): URL {
  const loopbackOrigin = configuredLoopbackOrigin();
  const requestHost = request.nextUrl.hostname;

  let url: URL;
  if (isLoopbackHostname(requestHost) || loopbackOrigin) {
    const origin = loopbackOrigin || `http://${request.nextUrl.host}`;
    url = new URL(pathname, origin.endsWith('/') ? origin : `${origin}/`);
    // Preserve non-default local port from the live request when env omits it.
    if (isLoopbackHostname(requestHost) && request.nextUrl.port) {
      url.port = request.nextUrl.port;
    }
  } else {
    url = new URL(pathname, request.url);
  }

  url.protocol = isLoopbackHostname(url.hostname) ? 'http:' : url.protocol;

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value == null || value === '') continue;
      url.searchParams.set(key, value);
    }
  }
  return url;
}

export function redirectToAppPath(
  request: NextRequest,
  pathname: string,
  query?: Record<string, string | null | undefined>,
): NextResponse {
  const url = appPathUrl(request, pathname, query);
  const response = NextResponse.redirect(url, 302);
  response.headers.set('Cache-Control', 'no-store');
  // Help clear a previously sticky HSTS pin on localhost from older builds.
  if (isLoopbackHostname(url.hostname)) {
    response.headers.set('Strict-Transport-Security', 'max-age=0');
  }
  return response;
}

export function dataSourceErrorRedirect(
  request: NextRequest,
  broker: 'zerodha' | 'shoonya',
  error: string,
): NextResponse {
  return redirectToAppPath(request, '/data-source', { broker, error });
}
