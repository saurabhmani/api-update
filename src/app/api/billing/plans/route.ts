import { NextResponse } from 'next/server';
import { listPlans } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** GET /api/billing/plans */
export async function GET() {
  return NextResponse.json({ ok: true, plans: listPlans() });
}
