import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getBrokerHealthReport } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** GET /api/broker/health */
export async function GET() {
  try {
    const user = await requireSession();
    const report = await getBrokerHealthReport(user.id);
    return NextResponse.json({ ok: true, ...report });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
