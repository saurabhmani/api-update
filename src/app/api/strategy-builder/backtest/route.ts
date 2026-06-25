import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { runLabBacktest } from '@/lib/strategy-lab';

export const dynamic = 'force-dynamic';

/** POST /api/strategy-builder/backtest */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const strategyId = String(body.strategyId ?? body.id ?? '');
    if (!strategyId) {
      return NextResponse.json({ ok: false, error: 'strategyId required' }, { status: 400 });
    }
    const result = await runLabBacktest(strategyId, user.email, body.config);
    return NextResponse.json({ ok: true, strategyId, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Backtest failed';
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
