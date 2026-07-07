import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { rechargeUserWallet } from '@/lib/billing';
import type { CreditType } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** POST /api/billing/wallet/recharge */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const creditType = String(body.creditType ?? body.credit_type ?? 'ai_builder') as CreditType;
    const amount = Number(body.amount ?? body.credits ?? 0);
    if (!amount || amount <= 0) {
      return NextResponse.json({ ok: false, error: 'amount required' }, { status: 400 });
    }
    const result = await rechargeUserWallet(user.id, creditType, amount, body.referenceId);
    return NextResponse.json({ ok: true, ...result, creditType });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Recharge failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
