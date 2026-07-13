import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadComparativeAnalytics, parseAnalyticsWindow } from '@/lib/strategy-hub/services/strategyAnalyticsService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/strategies/analytics/compare?ids=a,b,c&window=90D
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const url = req.nextUrl;
    const ids = (url.searchParams.get('ids') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length < 2) {
      return NextResponse.json(
        { ok: false, error: 'Provide at least two strategy ids via ids=a,b' },
        { status: 400 },
      );
    }
    const comparison = await loadComparativeAnalytics(
      ids,
      parseAnalyticsWindow(url.searchParams.get('window')),
    );
    return NextResponse.json({ ok: true, comparison }, {
      headers: { 'Cache-Control': 'private, max-age=60' },
    });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to compare strategies' }, { status: 500 });
  }
}
