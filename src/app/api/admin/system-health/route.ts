import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { getSystemHealthMonitor } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/** GET /api/admin/system-health — API health, data delays, system metrics */
export async function GET() {
  try {
    await requireAdmin();
    const health = await getSystemHealthMonitor();
    return NextResponse.json({ ok: true, health });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
