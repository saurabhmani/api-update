import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { syncBrokerOrders } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** GET /api/broker/orders */
export async function GET() {
  try {
    const user = await requireSession();
    const result = await syncBrokerOrders(user.id);
    return NextResponse.json({ ok: result.ok, orders: result.orders, synced: result.synced, error: result.error });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
