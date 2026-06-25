import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getOrCreateAccount } from '@/lib/paper-trading';

export const dynamic = 'force-dynamic';

/** GET /api/paper-trading/positions — open positions */
export async function GET() {
  try {
    const user = await requireSession();
    const summary = await getOrCreateAccount(user.id);
    return NextResponse.json({
      ok: true,
      positions: summary.openPositions,
      count: summary.openPositions.length,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
