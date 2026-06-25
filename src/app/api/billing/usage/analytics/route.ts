import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getUsageAnalytics } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** GET /api/billing/usage/analytics */
export async function GET(req: NextRequest) {
  try {
    const user = await requireSession();
    const days = parseInt(req.nextUrl.searchParams.get('days') ?? '30', 10);
    const analytics = await getUsageAnalytics(user.id, days);
    return NextResponse.json({ ok: true, analytics });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
