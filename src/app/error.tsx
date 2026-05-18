'use client';
import { useEffect } from 'react';
import { extractErrorMessage } from '@/lib/errors';

// DIGEST-CRASH-FIX-2026-05 — bullet-proof every accessor on `error`.
// Next.js's framework crash trace was:
//   TypeError: Cannot read properties of null (reading 'digest')
// at next-server/app-page.runtime.prod.js when a non-Error value (null,
// undefined, Response, plain object) propagated into the error boundary.
// We keep the exact same UI but never deref `error.message` /
// `error.digest` directly; `extractErrorMessage()` always returns a
// printable string, and the logged `digest` falls back to '(none)' so
// observers can still correlate without crashing the render.
export default function Error({
  error,
  reset,
}: {
  // The framework's nominal type promises `Error & { digest?: string }`
  // but in production we have observed `null` arrive here. Widen the
  // type at the boundary so TS doesn't tempt us into unsafe deref.
  error: (Error & { digest?: string }) | null | undefined;
  reset: () => void;
}) {
  const message = extractErrorMessage(error);
  const digest  = (error && (error as { digest?: string }).digest) ?? '(none)';
  const name    = (error && (error as { name?: string }).name)     ?? 'Error';

  // Structured log around the failing render branch so operators can
  // grep `[DASHBOARD_ERROR_BOUNDARY]` and see exactly what the framework
  // handed us — without ever rethrowing.
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[DASHBOARD_ERROR_BOUNDARY]', {
      scope:   'route',
      name,
      digest,
      message,
      hasErrorObject: error != null,
    });
  }, [error, message, digest, name]);

  return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <h2 style={{ color: '#DC2626', marginBottom: 12 }}>Something went wrong</h2>
      <p style={{ color: '#64748B', fontSize: 14, marginBottom: 20 }}>
        {message}
      </p>
      <button
        onClick={reset}
        style={{
          padding: '8px 20px', borderRadius: 6, border: 'none',
          background: '#1D4ED8', color: '#fff', fontWeight: 600,
          cursor: 'pointer', fontSize: 14,
        }}
      >
        Try again
      </button>
    </div>
  );
}
