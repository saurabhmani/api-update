'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div style={{ padding: 40, textAlign: 'center' }}>
      <h2 style={{ color: '#DC2626', marginBottom: 12 }}>Something went wrong</h2>
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
  );
}
