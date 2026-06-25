import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSubscriptionDetails, listPlans } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** GET /api/subscription */
export async function GET() {
  try {
    const user = await requireSession();
    const details = await getSubscriptionDetails(user.id);
    return NextResponse.json({ ok: true, ...details, plans: listPlans() });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
