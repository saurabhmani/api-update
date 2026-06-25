import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getOrCreateAccount } from '@/lib/paper-trading';

export const dynamic = 'force-dynamic';

/** GET /api/paper-trading/account — account summary + MTM */
export async function GET() {
  try {
    const user = await requireSession();
    const summary = await getOrCreateAccount(user.id);
    return NextResponse.json({ ok: true, ...summary });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

/** POST /api/paper-trading/account — reset or configure virtual capital */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const summary = await getOrCreateAccount(user.id);
    if (body.action === 'reset') {
      const { updateAccountBalances } = await import('@/lib/paper-trading/repository/paperTradingRepository');
      const capital = Number(body.virtualCapital ?? summary.account.virtualCapital);
      await updateAccountBalances(summary.account.id, {
        cashBalance: capital,
        equity: capital,
        realizedPnl: 0,
        unrealizedPnl: 0,
        dailyPnl: 0,
        consecutiveLosses: 0,
        killSwitchActive: false,
      });
      const refreshed = await getOrCreateAccount(user.id);
      return NextResponse.json({ ok: true, ...refreshed });
    }
    return NextResponse.json({ ok: true, ...summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
