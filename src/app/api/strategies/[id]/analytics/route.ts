import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import {
  ALL_SECTIONS,
  loadStrategyAnalytics,
  parseAnalyticsWindow,
  type AnalyticsSection,
} from '@/lib/strategy-hub/services/strategyAnalyticsService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type RouteContext = { params: Promise<{ id: string }> };

function parseSections(raw: string | null): AnalyticsSection[] {
  if (!raw?.trim()) return ALL_SECTIONS;
  const valid = new Set(ALL_SECTIONS);
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is AnalyticsSection => valid.has(s as AnalyticsSection));
}

/**
 * GET /api/strategies/[id]/analytics
 * Query: window, include (sections), regime, sector, skipCache=1
 */
export async function GET(req: NextRequest, context: RouteContext) {
  try {
    await requireSession();
    const { id } = await context.params;
    const url = req.nextUrl;
    const window = parseAnalyticsWindow(url.searchParams.get('window'));
    const sections = parseSections(url.searchParams.get('include') ?? url.searchParams.get('sections'));
    const skipCache = url.searchParams.get('skipCache') === '1';

    const dashboard = await loadStrategyAnalytics({
      strategyId: id,
      window,
      sections,
      skipCache,
      filters: {
        regime: url.searchParams.get('regime'),
        sector: url.searchParams.get('sector'),
        category: url.searchParams.get('category'),
        riskProfile: url.searchParams.get('riskProfile'),
      },
    });

    return NextResponse.json({ ok: true, ...dashboard }, {
      headers: { 'Cache-Control': 'private, max-age=60' },
    });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[strategies/analytics]', e);
    return NextResponse.json({ ok: false, error: 'Failed to load analytics' }, { status: 500 });
  }
}
