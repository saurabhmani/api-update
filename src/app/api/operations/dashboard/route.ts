// GET /api/operations/dashboard — Operational dashboard data (Phase 5)
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { collectOperationalDashboard } from '@/lib/operations/operationalDashboardCollector';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const dashboard = await collectOperationalDashboard();
    return NextResponse.json({ ok: true, dashboard });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
