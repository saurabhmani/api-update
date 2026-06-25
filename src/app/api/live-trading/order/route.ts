import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { placeLiveOrder } from '@/lib/broker';
import { syncBrokerOrders } from '@/lib/broker';
import type { BrokerPlaceOrderRequest } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** POST /api/live-trading/order */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = (await req.json().catch(() => ({}))) as BrokerPlaceOrderRequest;
    if (!body.symbol || !body.side || !body.quantity) {
      return NextResponse.json(
        { ok: false, error: 'symbol, side, quantity required' },
        { status: 400 },
      );
    }
    const result = await placeLiveOrder(user.id, body);
    if (result.ok) {
      await syncBrokerOrders(user.id);
    }
    const status = result.ok ? 201 : result.errorCode === 'GATES_FAILED' ? 403 : 422;
    return NextResponse.json({ ok: result.ok, ...result }, { status: result.ok ? 201 : status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Order failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
