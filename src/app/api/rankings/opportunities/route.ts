/**
 * GET /api/rankings/opportunities
 *
 * Real-time leaderboard of Phase-3 approved and confirmed trading
 * opportunities, ranked by opportunity score.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getMarketEnvelope } from '@/lib/marketData/marketHours';
import {
  loadOpportunityLeaderboard,
  type OpportunityLeaderboardFilters,
} from '@/lib/rankings/opportunityLeaderboard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const limitRaw = parseInt(searchParams.get('limit') ?? '50', 10);
  const pageRaw  = parseInt(searchParams.get('page')  ?? '1',  10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 50;
  const page  = Number.isFinite(pageRaw)  ? Math.max(pageRaw, 1) : 1;

  const filters: OpportunityLeaderboardFilters = {
    sector:     searchParams.get('sector')     ?? undefined,
    exchange:   searchParams.get('exchange')   ?? undefined,
    direction:  (searchParams.get('direction') as 'BUY' | 'SELL' | null) ?? undefined,
    strategy:   searchParams.get('strategy')   ?? undefined,
    timeframe:  searchParams.get('timeframe')  ?? undefined,
    conviction: searchParams.get('conviction') ?? undefined,
    risk:       (searchParams.get('risk') as 'low' | 'medium' | 'high' | null) ?? undefined,
    market:     searchParams.get('market')     ?? undefined,
    search:     searchParams.get('search')     ?? undefined,
    sort:       (searchParams.get('sort') as OpportunityLeaderboardFilters['sort']) ?? 'opportunity_rank',
    sortDir:    (searchParams.get('sortDir') as 'asc' | 'desc') ?? 'desc',
  };

  const market = getMarketEnvelope();

  try {
    const result = await loadOpportunityLeaderboard({
      limit,
      page,
      filters,
      enrichLive: market.isOpen,
    });

    const dataSource = market.isOpen ? 'live_feed' : 'last_close_cache';

    return NextResponse.json({
      ...result,
      mode:         market.mode,
      market_state: market.state,
      market_label: market.label,
      market_reason: market.reason,
      is_holiday:   market.isHoliday,
      now_ist:      market.nowIst,
      data_source:  dataSource,
      message: result.total === 0
        ? 'No approved trading opportunities right now. Signals must pass the Phase-3 approval gateway (and maturity promotion for confirmed rows).'
        : null,
    });
  } catch (err: unknown) {
    console.error('[/api/rankings/opportunities] Error:', (err as Error)?.message);
    return NextResponse.json(
      {
        error: 'Failed to fetch opportunity rankings',
        details: (err as Error)?.message,
        mode: market.mode,
        market_state: market.state,
      },
      { status: 500 },
    );
  }
}
