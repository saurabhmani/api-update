import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadStrategyAiInsights } from '@/lib/strategy-hub/services/strategyAiService';
import { parseAnalyticsWindow } from '@/lib/strategy-hub/services/strategyAnalyticsService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/strategies/[id]/ai/insights
 * Query: window, skipCache=1
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    await requireSession();
    const { id } = await context.params;
    const window = parseAnalyticsWindow(req.nextUrl.searchParams.get('window'));
    const skipCache = req.nextUrl.searchParams.get('skipCache') === '1';

    const insights = await loadStrategyAiInsights({
      strategyId: id,
      window,
      skipCache,
    });

    return NextResponse.json({ ok: true, ...insights }, {
      headers: { 'Cache-Control': 'private, max-age=60' },
    });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[strategies/ai/insights]', e);
    return NextResponse.json({ ok: false, error: 'Failed to load AI insights' }, { status: 500 });
  }
}
