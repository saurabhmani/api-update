import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getOrCreateAccount, refreshMarkToMarket } from '@/lib/paper-trading';

export const dynamic = 'force-dynamic';

/** GET /api/paper/positions — open + closed positions with account MTM */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession();
    const refresh = req.nextUrl.searchParams.get('refresh') === '1';
    const summary = refresh
      ? await refreshMarkToMarket(user.id)
      : await getOrCreateAccount(user.id);
    return NextResponse.json({
      ok: true,
      open: summary.openPositions,
      closed: summary.closedPositions ?? [],
      account: summary.account,
      mtm: summary.mtm,
      count: {
        open: summary.openPositions.length,
        closed: summary.closedPositions?.length ?? 0,
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
