import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { upgradeSubscription } from '@/lib/billing';
import type { SubscriptionPlan } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** POST /api/billing/upgrade */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const plan = String(body.plan) as SubscriptionPlan;
    if (!plan) {
      return NextResponse.json({ ok: false, error: 'plan required' }, { status: 400 });
    }
    const result = await upgradeSubscription(user.id, plan);
    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 422 });
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Upgrade failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
