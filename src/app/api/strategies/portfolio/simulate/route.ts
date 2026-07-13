import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import { runPortfolioSimulation, parsePortfolioWindow } from '@/lib/strategy-hub/services/portfolioService';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const window = parsePortfolioWindow(body.window ?? null);
    const simulation = await runPortfolioSimulation(body, window);
    return NextResponse.json({ ok: true, simulation });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: 'Simulation failed' }, { status: 500 });
  }
}
