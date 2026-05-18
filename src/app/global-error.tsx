'use client';
import { useEffect } from 'react';
import { extractErrorMessage } from '@/lib/errors';

// DIGEST-CRASH-FIX-2026-05 — same hardening as error.tsx but at the
// root boundary. The framework can pass `null` here in extremely
// edge cases (rejected promise with non-Error value during SSR); we
// guard every accessor so this boundary never re-throws.
export default function GlobalError({
  error,
  reset,
}: {
  error: (Error & { digest?: string }) | null | undefined;
  reset: () => void;
}) {
  const message = extractErrorMessage(error);
  const digest  = (error && (error as { digest?: string }).digest) ?? '(none)';
  const name    = (error && (error as { name?: string }).name)     ?? 'Error';

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[DASHBOARD_ERROR_BOUNDARY]', {
      scope:   'global',
      name,
      digest,
      message,
      hasErrorObject: error != null,
    });
  }, [error, message, digest, name]);

  return (
    <html>
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ padding: 40, textAlign: 'center', marginTop: 80 }}>
          <h2 style={{ color: '#DC2626', marginBottom: 12 }}>Application Error</h2>
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
      </body>
    </html>
  );
}
