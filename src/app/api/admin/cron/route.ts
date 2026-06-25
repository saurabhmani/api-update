import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { getCronMonitor } from '@/lib/admin';

export const dynamic = 'force-dynamic';

/** GET /api/admin/cron — cron job status + failed job logs */
export async function GET() {
  try {
    await requireAdmin();
    const cron = await getCronMonitor();
    return NextResponse.json({ ok: true, ...cron });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
