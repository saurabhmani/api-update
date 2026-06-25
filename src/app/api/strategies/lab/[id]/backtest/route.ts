import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getLabStrategy, buildBacktestConfig, recordLabBacktest } from '@/lib/strategy-lab';
import { handlePostBacktest } from '@/lib/backtesting/api/canonicalHandlers';

export const dynamic = 'force-dynamic';

/** POST /api/strategies/lab/[id]/backtest — queue backtest for lab strategy */
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
    if (!strategy.validated) {
      return NextResponse.json({ ok: false, error: 'Strategy must be validated before backtest' }, { status: 400 });
    }

    const btConfig = buildBacktestConfig(strategy.definition, id);
    const body = await req.json().catch(() => ({}));
    const mergedConfig = { ...btConfig.config, ...(body.config ?? {}) };

    const syntheticReq = new NextRequest(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: mergedConfig }),
    });
    const btResponse = await handlePostBacktest(syntheticReq);
    const btData = await btResponse.json();

    if (!btData.ok) {
      return NextResponse.json(btData, { status: btResponse.status });
    }

    const backtestId = String(btData.backtestId ?? btData.runId);
    const passed = btData.status === 'completed';
    await recordLabBacktest(id, backtestId, passed, user.email);

    return NextResponse.json({
      ok: true,
      backtestId,
      status: btData.status,
      mode: btData.mode,
      backtestPassed: passed,
      message: passed
        ? 'Backtest completed — eligible for paper deployment review'
        : 'Backtest queued — confirm when complete',
    }, { status: btResponse.status });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Backtest failed';
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
