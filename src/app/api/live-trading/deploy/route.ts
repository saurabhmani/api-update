import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { deployLiveTrading } from '@/lib/broker/services/liveTradingDeploy';
import type { BrokerName } from '@/lib/broker';

export const dynamic = 'force-dynamic';

/** POST /api/live-trading/deploy */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const strategyId = String(body.strategyId ?? body.id ?? '');
    if (!strategyId) {
      return NextResponse.json({ ok: false, error: 'strategyId required' }, { status: 400 });
    }
    const result = await deployLiveTrading(user.id, strategyId, user.email, {
      broker: body.broker as BrokerName | undefined,
      acceptDisclaimer: Boolean(body.acceptDisclaimer),
    });
    if (!result.approved) {
      return NextResponse.json({
        ok: false,
        approved: false,
        issues: result.issues,
        error: 'Live deployment gates not met',
      }, { status: 403 });
    }
    return NextResponse.json({
      ok: true,
      approved: true,
      deployment: 'live',
      accountId: result.accountId,
      message: 'Strategy deployed to live trading',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Deploy failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
