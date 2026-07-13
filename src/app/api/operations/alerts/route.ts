// GET /api/operations/alerts — Operational alerts (Phase 5, alerts only)
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { collectProductionHealth } from '@/lib/operations/productionHealthCollector';
import { evaluateOperationalAlerts } from '@/lib/operations/operationalAlerts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    await requireSession();
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const health = await collectProductionHealth();
    const alerts = evaluateOperationalAlerts({
      health,
      generatedAt: health.generatedAt,
    });
    return NextResponse.json({ ok: true, alerts, alertCount: alerts.length });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 500 });
  }
}
