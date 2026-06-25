import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { handleGetBacktest } from '@/lib/backtesting/api/canonicalHandlers';

export const dynamic = 'force-dynamic';

/**
 * GET /api/backtest/:id — backtest detail with summary, trades, equity curve
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireSession();
    const { id } = await params;
    return handleGetBacktest(id, req);
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
