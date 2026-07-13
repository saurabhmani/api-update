import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadSchedulerMonitor } from '@/lib/strategy-hub/services/strategyOperationsService';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await requireSession();
    const scheduler = await loadSchedulerMonitor();
    return NextResponse.json({ ok: true, ...scheduler });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load scheduler status' }, { status: 500 });
  }
}
