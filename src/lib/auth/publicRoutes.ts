/**
 * Public marketing / corporate routes that must never require a session.
 * Shared by the Next.js proxy and the browser API client so a 401 on
 * incidental auth probes cannot bounce visitors to /login.
 */

export const PUBLIC_EXACT_PATHS = [
  '/',
  '/services',
  '/industries',
  '/technologies',
  '/case-studies',
  '/insights',
  '/about',
  '/resources',
  '/careers',
  '/contact',
  '/privacy',
  '/terms',
  '/login',
  '/register',
  '/engines',
  '/gateway',
  '/platform',
  '/api/auth',
  '/api/contact',
  '/api/health',
  '/api/engine-health/status',
  '/api/events',
  '/api/market-data/health',
  '/api/market-data/dual-source/status',
  '/api/market-data/subscribe',
  '/api/market-data/reseed',
  '/api/market-data/bot',
  '/api/market-data/validate',
] as const;

export const PUBLIC_PATH_PREFIXES = [
  '/services/',
  '/industries/',
  '/resources/',
  '/technologies/',
  '/case-studies/',
  '/insights/',
  '/_next',
  '/favicon',
  '/images',
  '/fonts',
  '/api/auth/',
] as const;

/** Normalize trailing slashes so `/careers/` matches `/careers`. */
export function normalizePublicPath(pathname: string): string {
  if (!pathname) return '/';
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export function isPublicPath(pathname: string): boolean {
  const normalizedPath = normalizePublicPath(pathname);
  return (
    normalizedPath === '/'
    || (PUBLIC_EXACT_PATHS as readonly string[]).includes(normalizedPath)
    || (PUBLIC_PATH_PREFIXES as readonly string[]).some((prefix) =>
      normalizedPath.startsWith(prefix),
    )
  );
}
