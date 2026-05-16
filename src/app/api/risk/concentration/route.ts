// GET /api/risk/concentration — Concentration analysis (HHI, top-N, single-name)
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { computeConcentration } from '@/services/riskCoreService';
import { requireSession } from '@/lib/session';
import { resolveUserPortfolioId } from '@/lib/portfolioResolve';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const portfolioId = await resolveUserPortfolioId(user.id, req.nextUrl.searchParams.get('portfolioId'));
  if (portfolioId == null) return { data: null, hasPortfolio: false };

  const result = await computeConcentration(portfolioId);
  return { data: result, hasPortfolio: true };
});
