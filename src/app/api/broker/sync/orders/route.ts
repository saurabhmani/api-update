import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { syncBrokerOrders } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** POST /api/broker/sync/orders */
export async function POST() {
  try {
    const user = await requireSession();
    const result = await syncBrokerOrders(user.id);
    return NextResponse.json({ ok: result.ok, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Sync failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
