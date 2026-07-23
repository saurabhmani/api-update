import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Data Source Login requires a valid Quant session only.
 * Broker connection is optional here (this page is where users connect).
 */
export default async function DataSourceLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) {
    // Query string is preserved by src/proxy.ts when the session cookie is absent.
    redirect('/login?from=/data-source');
  }

  return (
    <Suspense
      fallback={
        <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
          Loading…
        </main>
      }
    >
      {children}
    </Suspense>
  );
}
