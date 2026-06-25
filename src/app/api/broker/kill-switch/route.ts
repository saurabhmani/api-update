import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { logBrokerKillSwitch } from '@/lib/broker/repository/brokerRepository';
import { isGlobalLiveKillSwitchActive } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** GET /api/broker/kill-switch */
export async function GET() {
  try {
    await requireSession();
    return NextResponse.json({
      ok: true,
      active: isGlobalLiveKillSwitchActive(),
      scope: 'global',
      env: process.env.LIVE_KILL_SWITCH ?? '0',
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** POST /api/broker/kill-switch — log user-level halt request (global via env) */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const action = body.action === 'activate' ? 'ACTIVATE' : 'DEACTIVATE';
    const reason = String(body.reason ?? 'User kill switch request');
    await logBrokerKillSwitch(user.id, action, reason, user.email, 'user');
    return NextResponse.json({
      ok: true,
      logged: true,
      globalActive: isGlobalLiveKillSwitchActive(),
      note: 'Set LIVE_KILL_SWITCH=1 in env for global halt',
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
