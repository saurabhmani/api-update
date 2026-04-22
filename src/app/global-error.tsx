'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ padding: 40, textAlign: 'center', marginTop: 80 }}>
          <h2 style={{ color: '#DC2626', marginBottom: 12 }}>Application Error</h2>
          <p style={{ color: '#64748B', fontSize: 14, marginBottom: 20 }}>
            {error.message || 'An unexpected error occurred'}
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
