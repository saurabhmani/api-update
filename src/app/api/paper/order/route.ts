import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { placePaperOrder, refreshMarkToMarket } from '@/lib/paper-trading';
import type { PlaceOrderRequest } from '@/lib/paper-trading';

export const dynamic = 'force-dynamic';

/** POST /api/paper/order — submit paper order */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = (await req.json().catch(() => ({}))) as PlaceOrderRequest & { refreshMtm?: boolean };
    if (!body.symbol || !body.side || !body.quantity) {
      return NextResponse.json(
        { ok: false, error: 'symbol, side, quantity required' },
        { status: 400 },
      );
    }
    const result = await placePaperOrder(user.id, body);
    if (body.refreshMtm !== false) {
      await refreshMarkToMarket(user.id);
    }
    const status = result.ok ? 201 : result.code === 'NO_ACCOUNT' ? 404 : 422;
    return NextResponse.json({ ok: result.ok, ...result }, { status: result.ok ? 201 : status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Order failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
