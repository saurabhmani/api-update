import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import {
  dispatchAlerts,
  evaluateProductionAlerts,
  getAlertChannelStatus,
  listAlertDeliveries,
} from '@/lib/reliability';

export const dynamic = 'force-dynamic';

/** GET /api/reliability/alerts — active alerts + channel config + delivery log */
export async function GET() {
  try {
    await requireAdmin();
    const [evalResult, deliveries, channels] = await Promise.all([
      evaluateProductionAlerts(),
      listAlertDeliveries(50),
      Promise.resolve(getAlertChannelStatus()),
    ]);
    return NextResponse.json({
      ok: true,
      summary: evalResult.summary,
      alerts: evalResult.alerts,
      channels,
      deliveries,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** POST /api/reliability/alerts — dispatch alerts to Slack/Email/System */
export async function POST(req: NextRequest) {
  try {
    const user = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    if (body.action === 'dispatch') {
      const result = await dispatchAlerts(user.id, user.email);
      return NextResponse.json({ ok: true, ...result });
    }
    return NextResponse.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (e: unknown) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Failed' },
      { status: 401 },
    );
  }
}
