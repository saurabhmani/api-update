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

/**
 * Canonical browser origin for post-login redirects.
 *
 * Prefer NEXT_PUBLIC_APP_URL so production (proxied to localhost:PORT)
 * never sends users to https://localhost:5000/kite/auth-complete.
 * Falls back to the request origin when the env var is unset (local/dev).
 */
export function resolveAuthCompleteOrigin(fallbackOrigin: string): string {
  const configured = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim();
  if (!configured) return fallbackOrigin;

  try {
    return new URL(configured).origin;
  } catch {
    return fallbackOrigin;
  }
}

export function buildAuthCompleteRedirectUrl(origin: string, code: string): string {
  const completeUrl = new URL('/kite/auth-complete', origin);
  completeUrl.hash = `code=${encodeURIComponent(code)}`;
  return completeUrl.toString();
}
