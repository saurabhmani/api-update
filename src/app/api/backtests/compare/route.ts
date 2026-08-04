import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { compareBacktestRuns } from '@/lib/backtesting/comparison/compareRuns';
import { backtestActorFromSession, getBacktestForActor } from '@/lib/backtesting/authorization/resourceAuthorization';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/backtests/compare?ids=run1,run2,run3
 * Comparison engine — side-by-side metrics across stored backtest runs.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireSession();
    const raw = req.nextUrl.searchParams.get('ids') ?? '';
    const runIds = raw.split(',').map((s) => s.trim()).filter(Boolean);

    if (runIds.length < 2) {
      return NextResponse.json(
        { ok: false, error: 'Provide at least 2 run IDs via ?ids=run1,run2' },
        { status: 400 },
      );
    }
    const actor = backtestActorFromSession(session);
    const authorized = await Promise.all(runIds.map(id => getBacktestForActor(id, actor)));
    if (authorized.some(run => !run)) return NextResponse.json({ ok:false,error:'Backtest not found' },{ status:404 });

    const comparison = await compareBacktestRuns(runIds);
    return NextResponse.json({ ok: true, ...comparison });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Compare failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
