function isHexDigit(char: string): boolean {
  return /[0-9A-Fa-f]/.test(char);
}

function fragmentHasMalformedPercentEncoding(fragment: string): boolean {
  for (let index = 0; index < fragment.length; index += 1) {
    if (fragment[index] !== '%') continue;

    if (index + 2 >= fragment.length) return true;

    const first = fragment[index + 1];
    const second = fragment[index + 2];
    if (!isHexDigit(first) || !isHexDigit(second)) return true;

    index += 2;
  }

  return false;
}

export function parseCompletionCodeFromHash(hash: string): string | null {
  if (!hash || hash === '#') return null;

  const fragment = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!fragment) return null;

  if (fragmentHasMalformedPercentEncoding(fragment)) return null;

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(fragment);
  } catch {
    return null;
  }

  const codes = params.getAll('code');
  if (codes.length !== 1) return null;

  const trimmed = codes[0].trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function stripCodeFragmentFromUrl(href: string): string {
  const url = new URL(href);
  url.hash = '';
  return `${url.pathname}${url.search}`;
}

/** True for localhost / loopback hosts that must never be used on live redirects. */
export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return (
      host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '[::1]'
      || host.endsWith('.localhost')
    );
  } catch {
    return true;
  }
}

function originFromConfiguredUrl(raw: string | undefined | null): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

/**
 * Read env without static `process.env.NEXT_PUBLIC_*` access so Next cannot
 * bake a stale build-time localhost value into the server redirect path.
 */
function readRuntimeEnv(name: string): string {
  return (process.env[name] ?? '').trim();
}

function originFromForwardedHeaders(headers?: Headers): string | null {
  if (!headers) return null;

  const xfHost = headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (!xfHost) return null;

  const xfProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https';
  try {
    return new URL(`${xfProto}://${xfHost}`).origin;
  } catch {
    return null;
  }
}

export interface ResolveAuthCompleteOriginOptions {
  headers?: Headers;
}

/**
 * Canonical browser origin for post-login redirects.
 *
 * Prefer a public origin from (in order):
 *   1. X-Forwarded-Host / non-loopback request origin (the host that handled
 *      the OAuth callback — keeps dig/prod users on the same host)
 *   2. APP_BASE_URL / APP_URL / NEXT_PUBLIC_APP_URL / KITE_REDIRECT_URL
 *
 * Loopback origins (localhost / 127.0.0.1) are skipped whenever any public
 * candidate exists — this is what was sending live users to
 * https://localhost:5000/kite/auth-complete.
 */
export function resolveAuthCompleteOrigin(
  fallbackOrigin: string,
  options: ResolveAuthCompleteOriginOptions = {},
): string {
  const liveCandidates: string[] = [];
  const forwarded = originFromForwardedHeaders(options.headers);
  if (forwarded) liveCandidates.push(forwarded);
  if (fallbackOrigin) liveCandidates.push(fallbackOrigin);

  const livePublic = liveCandidates.find((origin) => !isLoopbackOrigin(origin));
  if (livePublic) return livePublic;

  const envCandidates: string[] = [];
  for (const key of ['APP_BASE_URL', 'APP_URL', 'NEXT_PUBLIC_APP_URL', 'KITE_REDIRECT_URL'] as const) {
    const origin = originFromConfiguredUrl(readRuntimeEnv(key));
    if (origin) envCandidates.push(origin);
  }

  const envPublic = envCandidates.find((origin) => !isLoopbackOrigin(origin));
  if (envPublic) return envPublic;

  return fallbackOrigin || envCandidates[0] || liveCandidates[0] || 'http://localhost:3000';
}

export function buildAuthCompleteRedirectUrl(origin: string, code: string): string {
  const completeUrl = new URL('/kite/auth-complete', origin);
  completeUrl.hash = `code=${encodeURIComponent(code)}`;
  return completeUrl.toString();
}
