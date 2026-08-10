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
//    - Origin: NEVER derived from the inbound request URL (public
//      hostnames are unreachable from Node behind nginx). Always
//      loop back: INTERNAL_APP_URL → loopback APP_URL → 127.0.0.1:PORT.
//    - Timeout: every call has an AbortController budget (default 8s).
//    - Cookies: caller can forward the inbound `cookie` header so
//      session-protected routes keep working.
//    - Never throws — every failure mode resolves to a structured
//      result. Callers can render a clear operational state instead
//      of "fetch failed".
// ════════════════════════════════════════════════════════════════

import type { NextRequest } from 'next/server';
import { engineDebugger, getEngineDebugContext } from '@/lib/engineDebug/engineDebugger';

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
 * Resolve the absolute origin for server-to-server API calls within
 * this deployment. Never uses the inbound request URL — the public
 * HTTPS origin (e.g. https://quantorus.in) is not reachable from
 * Node behind nginx (hairpin NAT → fetch status 0).
 *
 * Order: INTERNAL_APP_URL → loopback APP_URL → http://127.0.0.1:PORT
 *
 * Never throws.
 */
export function resolveInternalOrigin(_req?: NextRequest | Request): string {
  const strip = (s: string) => s.replace(/\/+$/, '');
  const isLoopback = (origin: string): boolean =>
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(strip(origin));

  const internal = process.env.INTERNAL_APP_URL?.trim();
  if (internal) return strip(internal);

  const appUrl = process.env.APP_URL?.trim();
  if (appUrl && isLoopback(appUrl)) return strip(appUrl);

  const defaultPort = process.env.NODE_ENV === 'production' ? '5000' : '3000';
  const port = process.env.PORT?.trim() || defaultPort;
  return `http://127.0.0.1:${port}`;
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

  const debugCtx = getEngineDebugContext();
  const pathOnly = path.startsWith('http')
    ? (() => { try { return new URL(path).pathname; } catch { return path; } })()
    : path.split('?')[0];
  const extSpan = debugCtx
    ? engineDebugger.externalStart({
        target: pathOnly,
        function: debugCtx.function ?? 'internalFetch',
        engine: debugCtx.engine,
        requestId: debugCtx.requestId,
        file: 'src/lib/api/internalFetch.ts',
        meta: { timeoutMs },
      })
    : null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const mergedHeaders: Record<string, string> = { ...headers };
  if (cookieHeader) mergedHeaders.cookie = cookieHeader;
  // Never log cookie / auth headers — they stay in mergedHeaders only.

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
      extSpan?.end(res.status, { ok: false, elapsedMs });
      return {
        ok: false, status: res.status, data: null,
        error: errBody ?? `HTTP ${res.status}`,
        timedOut: false, elapsedMs, timeoutMs, url,
      };
    }
    const data = (await res.json()) as T;
    extSpan?.end(res.status, { ok: true, elapsedMs });
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
    if (timedOut) {
      extSpan?.end('timeout', { ok: false, elapsedMs });
    } else {
      extSpan?.error(err, { elapsedMs });
    }
    return {
      ok: false, status: 0, data: null,
      error: timedOut ? 'TIMEOUT' : raw,
      timedOut, elapsedMs, timeoutMs, url,
    };
  }
}
