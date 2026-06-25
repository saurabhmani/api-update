import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { disconnectBroker } from '@/lib/broker';
import type { BrokerName } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** POST /api/broker/disconnect */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const broker = body.broker as BrokerName | undefined;
    const result = await disconnectBroker(user.id, broker);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
    }
    return NextResponse.json({ ok: true, disconnected: true });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
