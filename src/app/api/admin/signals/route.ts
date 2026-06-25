import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { getSignalValidation } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/** GET /api/admin/signals — signal validation report */
export async function GET() {
  try {
    await requireAdmin();
    const signals = await getSignalValidation();
    return NextResponse.json({ ok: true, signals });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
