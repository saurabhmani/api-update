// GET /api/portfolio/overview — Full portfolio overview with holdings + P&L
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { getPortfolioOverview } from '@/services/portfolioLedgerService';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const portfolioIdParam = req.nextUrl.searchParams.get('portfolioId');

  let portfolioId: number;
  if (portfolioIdParam) {
    portfolioId = Number(portfolioIdParam);
  } else {
    const { rows } = await db.query(
      'SELECT id FROM portfolios WHERE user_id = ? LIMIT 1',
      [user.id],
    );
    // New users have no portfolio yet. Returning a 400 here painted
    // every empty-portfolio dashboard load as a "validation error" in
    // the logs and broke the UI's empty-state rendering. A 200 with a
    // null-portfolio envelope lets the frontend show the empty state
    // (or an "Add Portfolio" CTA) without log noise.
    if (!rows.length) {
      return { data: null, hasPortfolio: false };
    }
    portfolioId = (rows[0] as any).id;
  }

  const overview = await getPortfolioOverview(portfolioId);
  return { data: overview, hasPortfolio: true };
});
