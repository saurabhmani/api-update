import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadStrategyRankings, parseAnalyticsWindow } from '@/lib/strategy-hub/services/strategyAnalyticsService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/strategies/analytics/rankings
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const url = req.nextUrl;
    const result = await loadStrategyRankings({
      window: parseAnalyticsWindow(url.searchParams.get('window')),
      regime: url.searchParams.get('regime'),
      sector: url.searchParams.get('sector'),
      category: url.searchParams.get('category'),
      riskProfile: url.searchParams.get('riskProfile'),
      skipCache: url.searchParams.get('skipCache') === '1',
    });
    return NextResponse.json({ ok: true, ...result }, {
      headers: { 'Cache-Control': 'private, max-age=60' },
    });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load rankings' }, { status: 500 });
  }
}
