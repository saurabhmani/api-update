import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getAllUserFeatures } from '@/services/entitlement';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireSession();
    const data = await getAllUserFeatures(user);
    return NextResponse.json({ ...data, user_id: user.id });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function PUT() {
  return NextResponse.json({ error: 'Use POST /api/billing/admin/override to manage plans' }, { status: 400 });
}
