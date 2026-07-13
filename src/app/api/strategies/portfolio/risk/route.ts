import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import { loadPortfolioRisk, parsePortfolioWindow } from '@/lib/strategy-hub/services/portfolioService';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    await requireSession();
    const window = parsePortfolioWindow(req.nextUrl.searchParams.get('window'));
    const skipCache = req.nextUrl.searchParams.get('skipCache') === '1';
    const risk = await loadPortfolioRisk(window, skipCache);
    return NextResponse.json({ ok: true, risk });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load portfolio risk' }, { status: 500 });
  }
}
