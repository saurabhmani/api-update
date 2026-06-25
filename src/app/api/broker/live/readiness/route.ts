import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { evaluateLiveTradingGates } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** GET /api/broker/live/readiness */
export async function GET() {
  try {
    const user = await requireSession();
    const gates = await evaluateLiveTradingGates(user.id);
    return NextResponse.json({ ok: true, ...gates });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** POST /api/broker/live/readiness — re-evaluate with optional skip (admin) */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    await req.json().catch(() => ({}));
    const gates = await evaluateLiveTradingGates(user.id);
    return NextResponse.json({ ok: true, ...gates });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
