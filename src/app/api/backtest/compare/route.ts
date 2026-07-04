import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { compareBacktestRuns } from '@/lib/backtesting/comparison/compareRuns';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/backtest/compare?ids=run1,run2
 */
export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const raw = req.nextUrl.searchParams.get('ids') ?? '';
    const runIds = raw.split(',').map((s) => s.trim()).filter(Boolean);

    if (runIds.length < 2) {
      return NextResponse.json(
        { ok: false, error: 'Provide at least 2 run IDs via ?ids=run1,run2' },
        { status: 400 },
      );
    }

    const comparison = await compareBacktestRuns(runIds);
    return NextResponse.json({ ok: true, ...comparison });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Compare failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
