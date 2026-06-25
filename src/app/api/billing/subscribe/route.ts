import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { subscribeToPlan } from '@/lib/billing';
import type { SubscriptionPlan } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** POST /api/billing/subscribe */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const plan = String(body.plan ?? 'free') as SubscriptionPlan;
    const result = await subscribeToPlan(user.id, plan);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Subscribe failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
