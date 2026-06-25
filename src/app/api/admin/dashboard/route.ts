import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { buildAdminDashboard } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/** GET /api/admin/dashboard — system status, failed jobs, delays, alerts */
export async function GET() {
  try {
    const user = await requireAdmin();
    const dashboard = await buildAdminDashboard({ id: user.id, email: user.email });
    return NextResponse.json({ ok: true, dashboard });
  } catch (e: unknown) {
    const status = e && typeof e === 'object' && 'statusCode' in e
      ? Number((e as { statusCode: number }).statusCode) : 401;
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Unauthorized' },
      { status: status === 403 ? 403 : 401 },
    );
  }
}
