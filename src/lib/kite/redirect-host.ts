/**
 * Zerodha does not accept a dynamic redirect_uri on the login URL — it always
 * returns to the Redirect URL registered for the API key on developers.kite.trade.
 * That value must match KITE_REDIRECT_URL on the server hosting the callback.
 */

import type { NextRequest } from 'next/server';
import {
  isLoopbackOrigin,
  resolveAuthCompleteOrigin,
} from '@/lib/kite/auth-complete-fragment';

function originFromUrl(raw: string): string | null {
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return null;
  }
}

/** Origin registered for Kite callbacks (from env). */
export function getConfiguredKiteRedirectOrigin(): string | null {
  const redirectUrl = (process.env.KITE_REDIRECT_URL ?? '').trim();
  if (redirectUrl) return originFromUrl(redirectUrl);

  for (const key of ['APP_BASE_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL'] as const) {
    const origin = originFromUrl(process.env[key] ?? '');
    if (origin) return origin;
  }
  return null;
}

/**
 * True when the browser is on a different host than KITE_REDIRECT_URL.
 * Loopback-to-loopback (local next start) is always allowed.
 */
export function isKiteRedirectHostMismatch(request: NextRequest): boolean {
  const configured = getConfiguredKiteRedirectOrigin();
  if (!configured) return false;

  const live = resolveAuthCompleteOrigin(request.nextUrl.origin, {
    headers: request.headers,
  });

  if (configured === live) return false;
  if (isLoopbackOrigin(configured) && isLoopbackOrigin(live)) return false;
  return true;
}

/**
 * Zerodha sent the user to loopback while the server expects a public callback host.
 * Do not consume state/token on this wrong host.
 *
 * If X-Forwarded-Host is a public host, this is a reverse-proxy presentation of
 * the real app (not a Zerodha→localhost misconfiguration) — allow the callback.
 */
export function isKiteCallbackOnWrongLoopbackHost(request: NextRequest): boolean {
  const configured = getConfiguredKiteRedirectOrigin();
  if (!configured || isLoopbackOrigin(configured)) return false;

  const xfHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (xfHost) {
    try {
      const xfProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
      const xfOrigin = new URL(`${xfProto}://${xfHost}`).origin;
      if (!isLoopbackOrigin(xfOrigin)) return false;
    } catch {
      // fall through to raw host check
    }
  }

  return isLoopbackOrigin(request.nextUrl.origin);
}

export function buildKiteRedirectMismatchUrl(publicOrigin: string): string {
  const url = new URL('/data-source', publicOrigin);
  url.searchParams.set('broker', 'zerodha');
  url.searchParams.set('error', 'redirect_url_mismatch');
  return url.toString();
}
