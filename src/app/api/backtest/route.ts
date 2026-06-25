import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { handleListBacktests, handlePostBacktest } from '@/lib/backtesting/api/canonicalHandlers';

export const dynamic = 'force-dynamic';

/**
 * POST /api/backtest — queue or run a backtest (config in body)
 * GET  /api/backtest — list stored backtests
 */
export async function POST(req: NextRequest) {
  try {
    await requireSession();
    return handlePostBacktest(req);
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}

export async function GET() {
  try {
    await requireSession();
    return handleListBacktests();
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
