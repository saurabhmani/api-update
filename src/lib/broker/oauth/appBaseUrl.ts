/**
 * App public base URL helper.
 * Relocated from retired Shoonya OAuth module — used by status/disconnect redirects.
 */

export function resolveAppBaseUrl(): string {
  const base =
    process.env.APP_BASE_URL?.trim()
    || process.env.APP_URL?.trim()
    || process.env.NEXT_PUBLIC_APP_URL?.trim()
    || '';

  if (!base) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('APP_BASE_URL is required in production');
    }
    return 'http://localhost:3000';
  }

  return base.replace(/\/$/, '');
}
