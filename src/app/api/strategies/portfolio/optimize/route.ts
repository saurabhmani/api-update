import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { runPortfolioOptimization } from '@/lib/strategy-hub/services/portfolioService';
import type { OptimizationGoal } from '@/lib/strategy-hub/portfolio/types';

export const dynamic = 'force-dynamic';

const GOALS = new Set<OptimizationGoal>([
  'maximize_return', 'minimize_risk', 'balanced', 'income', 'growth', 'conservative',
]);

export async function POST(req: NextRequest) {
  try {
    await requireSession();
    const body = await req.json().catch(() => ({}));
    const goal = String(body.goal ?? 'balanced') as OptimizationGoal;
    if (!GOALS.has(goal)) {
      return NextResponse.json({ ok: false, error: 'Invalid optimization goal' }, { status: 400 });
    }
    const optimization = await runPortfolioOptimization(goal);
    return NextResponse.json({ ok: true, optimization });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Optimization failed' }, { status: 500 });
  }
}
