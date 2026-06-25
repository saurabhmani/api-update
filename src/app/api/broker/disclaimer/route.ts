import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { acceptDisclaimer, LIVE_DISCLAIMER_VERSION } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** POST /api/broker/disclaimer — accept live trading disclaimer */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    if (!body.accepted) {
      return NextResponse.json({ ok: false, error: 'Must accept disclaimer' }, { status: 400 });
    }
    const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? undefined;
    const ua = req.headers.get('user-agent') ?? undefined;
    await acceptDisclaimer(user.id, LIVE_DISCLAIMER_VERSION, ip ?? undefined, ua);
    return NextResponse.json({ ok: true, version: LIVE_DISCLAIMER_VERSION });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
