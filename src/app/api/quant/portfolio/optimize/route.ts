// GET/POST /api/quant/portfolio/optimize — risk-adjusted portfolio optimization

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { requireSession } from '@/lib/session';
import { resolveUserPortfolioId } from '@/lib/portfolioResolve';
import { optimizePortfolio } from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

async function runOptimize(req: NextRequest) {
  const user = await requireSession();
  const portfolioId = await resolveUserPortfolioId(user.id, req.nextUrl.searchParams.get('portfolioId'));
  if (portfolioId == null) return { hasPortfolio: false, data: null };
  const result = await optimizePortfolio(user.id, portfolioId);
  return { hasPortfolio: true, data: result };
}

export const GET = withApiHandler(runOptimize);
export const POST = withApiHandler(runOptimize);
