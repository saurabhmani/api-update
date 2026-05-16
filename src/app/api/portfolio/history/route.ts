// GET /api/portfolio/history — Historical NAV snapshots
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { getPortfolioHistory } from '@/services/portfolioLedgerService';
import { requireSession } from '@/lib/session';
import { resolveUserPortfolioId } from '@/lib/portfolioResolve';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const sp = req.nextUrl.searchParams;
  const days = sp.get('days') ? Number(sp.get('days')) : 90;

  const portfolioId = await resolveUserPortfolioId(user.id, sp.get('portfolioId'));
  if (portfolioId == null) {
    return { data: [], count: 0, hasPortfolio: false };
  }

  const history = await getPortfolioHistory(portfolioId, days);
  return { data: history, count: history.length, hasPortfolio: true };
});
