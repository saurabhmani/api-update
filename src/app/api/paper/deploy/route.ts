import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { deployToPaper } from '@/lib/paper-trading';

export const dynamic = 'force-dynamic';

/** POST /api/paper/deploy — deploy strategy to paper trading */
export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const body = await req.json().catch(() => ({}));
    const strategyId = String(body.strategyId ?? body.id ?? '');
    if (!strategyId) {
      return NextResponse.json({ ok: false, error: 'strategyId required' }, { status: 400 });
    }
    const result = await deployToPaper(user.id, strategyId, user.email);
    if (!result.approved) {
      return NextResponse.json({
        ok: false,
        approved: false,
        issues: result.issues,
        error: 'Deployment gates not met',
        hint: 'Run Validate Strategy on the strategy detail page before deploying',
      }, { status: 403 });
    }
    const { getEffectiveLifecycle } = await import('@/lib/strategy-hub/services/deploymentService');
    const deploymentLifecycle = await getEffectiveLifecycle(strategyId);
    return NextResponse.json({
      ok: true,
      approved: true,
      deployment: 'paper',
      deploymentLifecycle,
      accountId: result.accountId,
      message: 'Strategy deployed to paper trading',
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Deploy failed';
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
