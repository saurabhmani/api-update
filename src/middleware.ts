// ════════════════════════════════════════════════════════════════
// Auth Middleware — Clean & Fixed Version
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';

// Public routes (exact match)
const PUBLIC_PATHS = [
  '/',
  '/login',
  "/engines",
"/gateway",
  '/register',
  '/api/auth',
  '/api/health',
  '/api/events',
  '/api/kite/login',
  '/api/kite/callback',
  '/api/kite/postback',
  '/api/market-data/health',
  '/api/market-data/reseed',
  '/api/market-data/bot',
  '/api/market-data/validate',
];

// Public prefixes (for static + grouped routes)
const PUBLIC_PREFIXES = [
  '/_next',
  '/favicon',
  '/images',
  '/fonts',
];

// Check if path is public
function isPublicPath(pathname: string) {
  return (
     pathname === '/' ||    
    PUBLIC_PATHS.includes(pathname) ||
    PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix))
  );
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // DEBUG (remove in production if needed)
  console.log('MIDDLEWARE PATH:', pathname);

  // Allow public routes
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  // Check session cookie
  const session = req.cookies.get('q200_session')?.value;

  // If no session → block
  if (!session) {
    // API → return JSON
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Redirect to login
    const loginUrl = new URL('/login', req.url);
    loginUrl.searchParams.set('from', pathname);

    return NextResponse.redirect(loginUrl);
  }

  // Allow if session exists
  return NextResponse.next();
}

// Apply middleware to all routes except static assets
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};