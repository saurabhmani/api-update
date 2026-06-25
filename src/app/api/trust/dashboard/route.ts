import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { buildTrustDashboard } from '@/lib/trust-layer';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const user = await requireSession();
    const data = await buildTrustDashboard(user.id);
    return NextResponse.json({ ok: true, data });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
