import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getPremiumSummary } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** GET /api/billing/wallet */
export async function GET() {
  try {
    const user = await requireSession();
    const summary = await getPremiumSummary(user.id, user.role);
    return NextResponse.json({ ok: true, ...summary });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
