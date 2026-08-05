import { redirect } from 'next/navigation';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Dashboard requires Quant auth only.
 * Market data uses IndianAPI — broker connect is optional.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let session = null;
  try {
    session = await getSession();
  } catch {
    session = null;
  }
  if (!session) {
    redirect('/login?from=/dashboard');
  }

  return <>{children}</>;
}
