import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { loadTrustSignalBoard } from '@/lib/trust-layer';
import type { SignalBoardFilters } from '@/lib/trust-layer/services/trustSignalBoardService';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const url = req.nextUrl;
    const status = url.searchParams.get('status');
    const direction = url.searchParams.get('direction');
    const strategy = url.searchParams.get('strategy');
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));

    const filters: SignalBoardFilters = { limit };
    if (status === 'active' || status === 'closed' || status === 'all') {
      filters.status = status;
    }
    if (direction === 'BUY' || direction === 'SELL') {
      filters.direction = direction;
    }
    if (strategy) filters.strategy = strategy;

    const rows = await loadTrustSignalBoard(filters);
    const active = rows.filter((r) => r.lifecycle === 'active').length;
    const closed = rows.filter((r) => r.lifecycle === 'closed').length;

    return NextResponse.json({
      ok: true,
      data: rows,
      count: rows.length,
      meta: { active, closed, filters },
    });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
