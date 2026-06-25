import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getLabStrategy, recordLabBacktest } from '@/lib/strategy-lab';
import { loadBacktestRun } from '@/lib/backtesting/repository/persistence';
import { ensureBacktestTables } from '@/lib/backtesting/repository/migrate';

export const dynamic = 'force-dynamic';

/** POST /api/strategies/lab/[id]/backtest/confirm — mark backtest passed after async completion */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const strategy = await getLabStrategy(id);
    if (!strategy) {
      return NextResponse.json({ ok: false, error: 'Strategy not found' }, { status: 404 });
    }

    const body = await req.json().catch(() => ({}));
    const backtestId = String(body.backtestId ?? strategy.lastBacktestId ?? '');
    if (!backtestId) {
      return NextResponse.json({ ok: false, error: 'backtestId required' }, { status: 400 });
    }

    await ensureBacktestTables();
    const run = await loadBacktestRun(backtestId);
    if (!run) {
      return NextResponse.json({ ok: false, error: 'Backtest not found' }, { status: 404 });
    }

    const passed = run.status === 'completed';
    await recordLabBacktest(id, backtestId, passed, user.email);

    return NextResponse.json({
      ok: true,
      backtestId,
      status: run.status,
      backtestPassed: passed,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Confirm failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
