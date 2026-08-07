// Auth proxy — Next.js 16 replacement for middleware.ts

import { NextRequest, NextResponse } from 'next/server';
import { isPublicPath } from '@/lib/auth/publicRoutes';
import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
  createRequestNonce,
} from '@/lib/security/csp';

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isDev(): boolean {
  return process.env.NODE_ENV === 'development';
}

/** Local `next start` still has NODE_ENV=production — do not force HTTPS on loopback. */
function isLoopbackAppHost(): boolean {
  for (const key of ['APP_BASE_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL'] as const) {
    const raw = (process.env[key] ?? '').trim();
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      if (
        host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || host.endsWith('.localhost')
      ) {
        return true;
      }
    } catch {
      // ignore invalid
    }
  }
  return false;
}

function withSecurity(
  request: NextRequest,
  response: NextResponse,
  nonce: string,
): NextResponse {
  const loopback = isLoopbackAppHost();
  const headerOptions = {
    nonce,
    pathname: request.nextUrl.pathname,
    isDev: isDev() || loopback,
    // npm start sets NODE_ENV=production; skip HTTPS upgrades/HSTS on localhost
    // or browsers rewrite Shoonya/Kite callbacks to https://localhost and break OAuth.
    isProduction: isProduction() && !loopback,
  };

  applySecurityHeaders(response.headers, headerOptions);

  // Clear any previously cached HSTS for localhost from older production builds.
  if (loopback) {
    response.headers.set('Strict-Transport-Security', 'max-age=0');
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', buildContentSecurityPolicy(headerOptions));

  response.headers.set('x-nonce', nonce);
  return response;
}

function secureNext(request: NextRequest, nonce: string): NextResponse {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const response = NextResponse.next({
    request: { headers: requestHeaders },
  });

  return withSecurity(request, response, nonce);
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const nonce = createRequestNonce();

  if (process.env.LOG_VERBOSE_MIDDLEWARE === '1') {
    console.log('MIDDLEWARE PATH:', pathname);
  }

  // Corporate + public API paths never enter the session gate.
  if (isPublicPath(pathname)) {
    return secureNext(req, nonce);
  }

  const session = req.cookies.get('q200_session')?.value;
  if (!session) {
    if (pathname.startsWith('/api/')) {
      const response = NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      );
      return withSecurity(req, response, nonce);
    }

    const loginUrl = new URL('/login', req.url);
    // Preserve path + query so post-login can restore the destination.
    // Use the decoded pathname so characters like `|` (instrument keys
    // `NSE_EQ|SYMBOL`) are not double-encoded into `%257C`, which breaks
    // post-login navigation and leaves the market detail page on a bad key.
    const rawPath = (() => {
      try {
        return decodeURIComponent(pathname);
      } catch {
        return pathname;
      }
    })();
    const from =
      req.nextUrl.search && req.nextUrl.search.length > 1
        ? `${rawPath}${req.nextUrl.search}`
        : rawPath;
    loginUrl.searchParams.set('from', from);
    const response = NextResponse.redirect(loginUrl);
    return withSecurity(req, response, nonce);
  }

  return secureNext(req, nonce);
}

export const config = {
  matcher: [
    // Next 16's proxy only runs for genuinely private product surfaces and API
    // requests. Public-facing corporate routes are omitted from this matcher so
    // they never enter the auth flow (even before isPublicPath).
    '/admin/:path*',
    '/dashboard/:path*',
    '/settings/:path*',
    '/data-source/:path*',
    '/trade-journal/:path*',
    '/trade-setups/:path*',
    '/watchlist/:path*',
    '/signals/:path*',
    '/options/:path*',
    '/quant/:path*',
    '/portfolio/:path*',
    '/paper/:path*',
    '/strategies/:path*',
    '/backtesting/:path*',
    '/notifications/:path*',
    '/market/:path*',
    '/stocks/:path*',
    '/rankings/:path*',
    '/intelligence/:path*',
    '/calibration/:path*',
    '/manipulation/:path*',
    '/surveillance/:path*',
    '/news-intelligence/:path*',
    '/news/:path*',
    '/reports/:path*',
    '/trust/:path*',
    '/compliance/:path*',
    '/dexter/:path*',
    '/billing/:path*',
    '/api/:path*',
  ],
};
