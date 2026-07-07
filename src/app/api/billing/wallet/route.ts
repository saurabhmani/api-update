import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getPremiumSummary, getWalletSummary } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** GET /api/billing/wallet */
export async function GET() {
  try {
    const user = await requireSession();
    const [premium, wallet] = await Promise.all([
      getPremiumSummary(user.id, user.role),
      getWalletSummary(user.id),
    ]);
    return NextResponse.json({
      ok: true,
      ...premium,
      transactions: wallet.transactions,
      payments: wallet.payments,
      usageLogs: wallet.usageLogs,
      totalBalance: wallet.totalBalance,
      totalCreditsRemaining: premium.totalCreditsRemaining,
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
