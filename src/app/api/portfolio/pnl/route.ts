// GET /api/portfolio/pnl — P&L breakdown (unrealized + realized)
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { computePnl } from '@/services/portfolioLedgerService';
import { requireSession } from '@/lib/session';
import { resolveUserPortfolioId } from '@/lib/portfolioResolve';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const portfolioId = await resolveUserPortfolioId(user.id, req.nextUrl.searchParams.get('portfolioId'));
  if (portfolioId == null) return { data: null, hasPortfolio: false };

  const pnl = await computePnl(portfolioId);
  return { data: pnl, hasPortfolio: true };
});
