import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { refreshMarkToMarket } from '@/lib/paper-trading';

export const dynamic = 'force-dynamic';

/** POST /api/paper-trading/mtm — refresh mark-to-market + SL/TP */
export async function POST() {
  try {
    const user = await requireSession();
    const summary = await refreshMarkToMarket(user.id);
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'MTM refresh failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
