import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadOperationsDashboard } from '@/lib/strategy-hub/services/strategyOperationsService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/strategies/operations — operations dashboard */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const skipCache = req.nextUrl.searchParams.get('skipCache') === '1';
    const dashboard = await loadOperationsDashboard({ skipCache });
    return NextResponse.json({ ok: true, ...dashboard }, {
      headers: { 'Cache-Control': 'private, max-age=30' },
    });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load operations dashboard' }, { status: 500 });
  }
}
