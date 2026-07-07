// Auth proxy — Next.js 16 replacement for middleware.ts

import { NextRequest, NextResponse } from 'next/server';

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

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (process.env.LOG_VERBOSE_MIDDLEWARE === '1') {
    console.log('MIDDLEWARE PATH:', pathname);
  }

  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  const session = req.cookies.get('q200_session')?.value;
  if (!session) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      );
    }

    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('from', pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
