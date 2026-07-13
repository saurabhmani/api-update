import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadHubAiRecommendations } from '@/lib/strategy-hub/services/strategyAiService';
import { parseAnalyticsWindow } from '@/lib/strategy-hub/services/strategyAnalyticsService';

export const dynamic = 'force-dynamic';

/**
 * GET /api/strategies/ai/recommendations
 * Query: window, limit, skipCache=1
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const window = parseAnalyticsWindow(req.nextUrl.searchParams.get('window'));
    const limit = Math.min(Number(req.nextUrl.searchParams.get('limit') ?? 50), 100);
    const skipCache = req.nextUrl.searchParams.get('skipCache') === '1';

    const payload = await loadHubAiRecommendations({ window, limit, skipCache });
    return NextResponse.json({ ok: true, ...payload });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load recommendations' }, { status: 500 });
  }
}
