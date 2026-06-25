// POST /api/portfolio/optimize — Portfolio Optimizer (acceptance spec)

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { requireSession } from '@/lib/session';
import { resolveUserPortfolioId } from '@/lib/portfolioResolve';
import { optimizePortfolio } from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const portfolioId = await resolveUserPortfolioId(user.id, req.nextUrl.searchParams.get('portfolioId'));
  if (portfolioId == null) return { hasPortfolio: false, data: null };
  const data = await optimizePortfolio(user.id, portfolioId);
  return { hasPortfolio: true, data };
});

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json().catch(() => ({}));
  const portfolioId = await resolveUserPortfolioId(
    user.id,
    body.portfolioId != null ? String(body.portfolioId) : req.nextUrl.searchParams.get('portfolioId'),
  );
  if (portfolioId == null) return { hasPortfolio: false, data: null };
  const data = await optimizePortfolio(user.id, portfolioId);
  return { hasPortfolio: true, data };
});
