import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';
import { resolvePostLoginDestination } from '@/lib/broker/connections';

export const dynamic = 'force-dynamic';

/**
 * Dashboard requires Quant auth + an explicit active data source.
 * needsSelection / none → /data-source.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) {
    redirect('/login?from=/dashboard');
  }

  try {
    const dest = await resolvePostLoginDestination(session.id);
    if (dest.path === '/data-source') {
      const qs = dest.reason ? `?reason=${dest.reason}` : '';
      redirect(`/data-source${qs}`);
    }
  } catch {
    // Keep dashboard reachable during transient DB/Redis failures.
  }

  return <>{children}</>;
}
