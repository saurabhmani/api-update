import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { syncBrokerPositions } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** GET /api/live-trading/positions — sync + return live positions */
export async function GET() {
  try {
    const user = await requireSession();
    const result = await syncBrokerPositions(user.id);
    const open = (result.positions ?? []).filter(
      (p: Record<string, unknown>) => String(p.status) === 'OPEN',
    );
    const closed = (result.positions ?? []).filter(
      (p: Record<string, unknown>) => String(p.status) === 'CLOSED',
    );
    return NextResponse.json({
      ok: result.ok,
      positions: result.positions,
      open,
      closed,
      synced: result.synced,
      count: { open: open.length, closed: closed.length, total: result.positions?.length ?? 0 },
      error: result.error,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
