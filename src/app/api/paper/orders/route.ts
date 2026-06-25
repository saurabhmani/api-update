import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getOrderBook } from '@/lib/paper-trading';

export const dynamic = 'force-dynamic';

/** GET /api/paper/orders — order book */
export async function GET() {
  try {
    const user = await requireSession();
    const book = await getOrderBook(user.id);
    const pending = book.orders.filter((o) => ['PENDING', 'SUBMITTED', 'PARTIAL'].includes(o.status));
    const history = book.orders.filter((o) => !['PENDING', 'SUBMITTED', 'PARTIAL'].includes(o.status));
    return NextResponse.json({
      ok: true,
      orders: book.orders,
      pending,
      history,
      market: book.market,
      count: book.orders.length,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
