import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getOrderBook, placePaperOrder } from '@/lib/paper-trading';
import type { PlaceOrderRequest } from '@/lib/paper-trading';
import { invalidatePaperTradingCaches } from '@/lib/cache/cacheInvalidation';

export const dynamic = 'force-dynamic';

/** GET /api/paper-trading/orders — order book */
export async function GET() {
  try {
    const user = await requireSession();
    const book = await getOrderBook(user.id);
    return NextResponse.json({ ok: true, ...book });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** POST /api/paper-trading/orders — submit paper order */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = (await req.json().catch(() => ({}))) as PlaceOrderRequest;
    if (!body.symbol || !body.side || !body.quantity) {
      return NextResponse.json(
        { ok: false, error: 'symbol, side, quantity required' },
        { status: 400 },
      );
    }
    const result = await placePaperOrder(user.id, body);
    const status = result.ok ? 201 : result.code === 'NO_ACCOUNT' ? 404 : 422;
    if (result.ok) await invalidatePaperTradingCaches(user.id);
    return NextResponse.json({ ok: result.ok, ...result }, { status: result.ok ? 201 : status });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Order failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
