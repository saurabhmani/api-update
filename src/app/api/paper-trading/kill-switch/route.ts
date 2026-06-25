import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getKillSwitchState, setKillSwitch } from '@/lib/paper-trading';

export const dynamic = 'force-dynamic';

/** GET /api/paper-trading/kill-switch */
export async function GET() {
  try {
    const user = await requireSession();
    const state = await getKillSwitchState(user.id);
    return NextResponse.json({ ok: true, ...state });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** POST /api/paper-trading/kill-switch — activate or deactivate */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const activate = body.action === 'activate' || body.activate === true;
    const reason = String(body.reason ?? (activate ? 'Manual halt' : 'Manual resume'));
    const result = await setKillSwitch(user.id, activate, reason, user.email);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Kill switch failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
