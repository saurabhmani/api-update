// ════════════════════════════════════════════════════════════════
//  internalFetch — safe server-side fetch for other Next.js API
//  routes inside the same deployment.
//
//  Why this exists:
//    The engine-health / dashboard aggregators call sibling API
//    routes via `fetch()` to read the same envelope the UI sees.
//    A relative URL fails on the server (no Origin header), and a
//    raw absolute call without a timeout can hang the route long
//    enough to surface as "fetch failed" / 504 in the UI.
//
//  Contract:
//    - Origin: prefer the inbound request's protocol+host (NextRequest
//      has `nextUrl` for this); fall back to NEXT_PUBLIC_APP_URL,
//      then APP_URL, then `http://localhost:${PORT || 3000}`.
//    - Timeout: every call has an AbortController budget (default 8s).
//    - Cookies: caller can forward the inbound `cookie` header so
//      session-protected routes keep working.
//    - Never throws — every failure mode resolves to a structured
//      result. Callers can render a clear operational state instead
//      of "fetch failed".
// ════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';

export interface InternalFetchResult<T = unknown> {
  ok:         boolean;
  status:     number;
  data:       T | null;
  error:      string | null;
  /** True when the AbortController fired (vs network / route failure). */
  timedOut:   boolean;
  /** Wall-clock duration in ms. */
  elapsedMs:  number;
  /** Per-call timeout budget that was applied. */
  timeoutMs:  number;
  /** Final absolute URL that was hit — useful for diagnostic logging. */
  url:        string;
}

export interface InternalFetchOptions {
  /** Forward this cookie header on the internal call (default ''). */
  cookieHeader?: string;
  /** AbortController budget. Default 8s. */
  timeoutMs?:    number;
  /** Optional method override (default 'GET'). */
  method?:       'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Optional body for non-GET methods. */
  body?:         BodyInit | null;
  /** Extra headers (merged with cookie). */
  headers?:      Record<string, string>;
}

/**
 * Resolve the absolute origin we should hit. Order:
 *   1. The inbound NextRequest's nextUrl.origin (cheapest, most accurate).
 *   2. process.env.NEXT_PUBLIC_APP_URL (public canonical URL).
 *   3. process.env.APP_URL (private canonical URL).
 *   4. http://localhost:${PORT||3000} (dev fallback).
 *
 * Never throws — returns the localhost fallback as a last resort so
 * the caller can still attempt the request rather than failing fast.
 */
export function resolveInternalOrigin(req?: NextRequest | Request): string {
  // 1. Inbound request — preferred. NextRequest exposes `nextUrl`.
  if (req && 'nextUrl' in req && (req as NextRequest).nextUrl?.origin) {
    return (req as NextRequest).nextUrl.origin;
  }
  // Plain Request still has `url` so URL() can parse it.
  if (req?.url) {
    try {
      const u = new URL(req.url);
      if (u.origin && u.origin !== 'null') return u.origin;
    } catch { /* fall through */ }
  }
  // 2. Public URL env.
  const pub = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (pub) return pub.replace(/\/+$/, '');
  // 3. Private URL env.
  const priv = process.env.APP_URL?.trim();
  if (priv) return priv.replace(/\/+$/, '');
  // 4. Dev fallback.
  const port = process.env.PORT?.trim() || '3000';
  return `http://localhost:${port}`;
}

/**
 * Call another API route on this same deployment. Always resolves —
 * never throws.
 *
 * Usage:
 *   const r = await internalFetch<MyShape>(req, '/api/signals', {
 *     cookieHeader: req.headers.get('cookie') ?? '',
 *     timeoutMs:    8_000,
 *   });
 *   if (!r.ok) { ...handle r.timedOut / r.status... }
 */
export async function internalFetch<T = unknown>(
  req: NextRequest | Request | undefined,
  path: string,
  options: InternalFetchOptions = {},
): Promise<InternalFetchResult<T>> {
  const {
    cookieHeader = '',
    timeoutMs    = 8_000,
    method       = 'GET',
    body         = null,
    headers      = {},
  } = options;

  const origin = resolveInternalOrigin(req);
  const url    = path.startsWith('http') ? path : `${origin}${path}`;
  const t0     = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const mergedHeaders: Record<string, string> = { ...headers };
  if (cookieHeader) mergedHeaders.cookie = cookieHeader;

  try {
    const res = await fetch(url, {
      method,
      cache:   'no-store',
      headers: mergedHeaders,
      body:    method === 'GET' ? undefined : body,
      signal:  controller.signal,
    });
    clearTimeout(timer);
    const elapsedMs = Date.now() - t0;
    if (!res.ok) {
      // Best-effort JSON error body — never let the parse failure
      // mask the underlying status code.
      let errBody: string | null = null;
      try {
        const parsed = await res.clone().json();
        errBody = parsed?.error ?? parsed?.message ?? null;
      } catch { /* non-JSON error response */ }
      return {
        ok: false, status: res.status, data: null,
        error: errBody ?? `HTTP ${res.status}`,
        timedOut: false, elapsedMs, timeoutMs, url,
      };
    }
    const data = (await res.json()) as T;
    return {
      ok: true, status: res.status, data, error: null,
      timedOut: false, elapsedMs, timeoutMs, url,
    };
  } catch (err) {
    clearTimeout(timer);
    const elapsedMs = Date.now() - t0;
    const raw = err instanceof Error ? err.message : String(err);
    const lower = raw.toLowerCase();
    const timedOut =
      controller.signal.aborted ||
      lower.includes('aborted') ||
      lower.includes('operation was aborted');
    return {
      ok: false, status: 0, data: null,
      error: timedOut ? 'TIMEOUT' : raw,
      timedOut, elapsedMs, timeoutMs, url,
    };
  }
}
