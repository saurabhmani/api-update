/**
 * Same-host redirects for in-app pages (data-source, dashboard, login).
 *
 * Prefer the browser-facing public host (APP_* / X-Forwarded-*), never the
 * internal loopback Next sees behind nginx (`Host: localhost:3000`). That
 * mis-detection was sending dig OAuth successes to http://localhost:3000.
 */

import { NextRequest, NextResponse } from 'next/server';

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

function originFromUrl(raw: string): string | null {
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

function originFromForwardedHeaders(headers: Headers): string | null {
  const xfHost = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (!xfHost) return null;
  const xfProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
  try {
    return new URL(`${xfProto}://${xfHost}`).origin;
  } catch {
    return null;
  }
}

/** nginx `proxy_set_header Host $host` — public even when X-Forwarded-Host is missing. */
function originFromHostHeader(headers: Headers): string | null {
  const host = headers.get('host')?.split(',')[0]?.trim();
  if (!host) return null;
  const xfProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
  try {
    return new URL(`${xfProto}://${host}`).origin;
  } catch {
    return null;
  }
}

function configuredAppOrigin(): string | null {
  for (const key of ['APP_BASE_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL'] as const) {
    const origin = originFromUrl(process.env[key] ?? '');
    if (origin) return origin;
  }
  return null;
}

function isPublicOrigin(origin: string): boolean {
  try {
    return !isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/**
 * Canonical browser origin for post-OAuth in-app redirects.
 * Public hosts always win over internal loopback.
 */
export function resolveAppRedirectOrigin(request: NextRequest): string {
  const forwarded = originFromForwardedHeaders(request.headers);
  const hostHeader = originFromHostHeader(request.headers);
  const configured = configuredAppOrigin();
  const requestOrigin = request.nextUrl.origin;

  // Prefer proxy/public Host before configured APP_* so a leftover
  // localhost APP_BASE_URL on dig cannot bounce OAuth to loopback.
  const candidates = [forwarded, hostHeader, configured, requestOrigin].filter(
    (value): value is string => Boolean(value),
  );

  const publicOrigin = candidates.find(isPublicOrigin);
  if (publicOrigin) return publicOrigin;

  // Production must never send users to loopback after broker OAuth.
  if (process.env.NODE_ENV === 'production') {
    console.error('[appRedirects] no public origin for OAuth redirect', {
      forwarded,
      hostHeader,
      configured,
      requestOrigin,
    });
  }

  // Local-only: prefer configured loopback http, else request (forced http).
  for (const origin of candidates) {
    try {
      const url = new URL(origin);
      if (isLoopbackHostname(url.hostname)) {
        url.protocol = 'http:';
        return url.origin;
      }
    } catch {
      // continue
    }
  }

  return 'http://localhost:3000';
}

/** Build an in-app absolute URL on the browser-facing origin. */
export function appPathUrl(
  request: NextRequest,
  pathname: string,
  query?: Record<string, string | null | undefined>,
): URL {
  const origin = resolveAppRedirectOrigin(request);
  const url = new URL(pathname, origin.endsWith('/') ? origin : `${origin}/`);

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
