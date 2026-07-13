import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import { loadAlertsWithNames } from '@/lib/strategy-hub/services/strategyOperationsService';
import { updateAlertStatus } from '@/lib/strategy-hub/repository/opsAlerts';
import { recordOpsEvent } from '@/lib/strategy-hub/repository/opsEvents';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const status = (req.nextUrl.searchParams.get('status') ?? 'open') as 'open' | 'acknowledged' | 'resolved' | 'all';
    const strategyId = req.nextUrl.searchParams.get('strategyId') ?? undefined;
    const alerts = await loadAlertsWithNames({ status, strategyId, limit: 100 });
    return NextResponse.json({ ok: true, alerts });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load alerts' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const alertId = Number(body.alertId);
    const action = String(body.action ?? '');
    if (!alertId || !['acknowledge', 'resolve'].includes(action)) {
      return NextResponse.json({ ok: false, error: 'alertId and action required' }, { status: 400 });
    }
    const status = action === 'acknowledge' ? 'acknowledged' : 'resolved';
    const ok = await updateAlertStatus(alertId, status, admin.email ?? `user:${admin.id}`);
    if (ok) {
      await recordOpsEvent({
        eventType: 'alert-status',
        title: `Alert ${status}`,
        description: `Alert #${alertId} marked ${status}`,
        actor: admin.email ?? `user:${admin.id}`,
      });
    }
    return NextResponse.json({ ok });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to update alert' }, { status: 500 });
  }
}
