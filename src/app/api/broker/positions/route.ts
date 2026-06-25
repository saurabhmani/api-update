import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { syncBrokerPositions } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** GET /api/broker/positions */
export async function GET() {
  try {
    const user = await requireSession();
    const result = await syncBrokerPositions(user.id);
    return NextResponse.json({ ok: result.ok, positions: result.positions, synced: result.synced, error: result.error });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
