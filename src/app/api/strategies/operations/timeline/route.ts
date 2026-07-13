import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { buildActivityTimeline } from '@/lib/strategy-hub/services/strategyOperationsService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const url = req.nextUrl;
    const timeline = await buildActivityTimeline({
      strategyId: url.searchParams.get('strategyId') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
      category: url.searchParams.get('category') as never,
      limit: Number(url.searchParams.get('limit') ?? 100),
    });
    return NextResponse.json({ ok: true, timeline });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load timeline' }, { status: 500 });
  }
}
