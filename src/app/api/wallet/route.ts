import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getWalletSummary } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** GET /api/wallet — balance, credits, transactions, payments, usage logs */
export async function GET() {
  try {
    const user = await requireSession();
    const wallet = await getWalletSummary(user.id);
    return NextResponse.json({ ok: true, ...wallet });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
