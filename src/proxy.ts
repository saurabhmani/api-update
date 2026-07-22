// Auth proxy — Next.js 16 replacement for middleware.ts

import { NextRequest, NextResponse } from 'next/server';
import {
  applySecurityHeaders,
  buildContentSecurityPolicy,
  createRequestNonce,
} from '@/lib/security/csp';

const PUBLIC_PATHS = [
  '/',
  '/login',
  '/engines',
  '/gateway',
  '/register',
  '/api/auth',
  '/api/health',
  '/api/engine-health/status',
  '/api/events',
  '/api/market-data/health',
  '/api/market-data/live-feed-status',
  '/api/market-data/dual-source/status',
  '/api/market-data/subscribe',
  '/api/market-data/reseed',
  '/api/market-data/bot',
  '/api/market-data/validate',
];

const PUBLIC_PREFIXES = [
  '/_next',
  '/favicon',
  '/images',
  '/fonts',
];

function isPublicPath(pathname: string) {
  return (
    pathname === '/'
    || PUBLIC_PATHS.includes(pathname)
    || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function isDev(): boolean {
  return process.env.NODE_ENV === 'development';
}

function withSecurity(
  request: NextRequest,
  response: NextResponse,
  nonce: string,
): NextResponse {
  const headerOptions = {
    nonce,
    pathname: request.nextUrl.pathname,
    isDev: isDev(),
    isProduction: isProduction(),
  };

  applySecurityHeaders(response.headers, headerOptions);

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
    loginUrl.searchParams.set('from', pathname);
    const response = NextResponse.redirect(loginUrl);
    return withSecurity(req, response, nonce);
  }

  return secureNext(req, nonce);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
