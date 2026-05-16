// GET /api/canonical/portfolios — List portfolios (with optional userId filter)
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { getPortfolios } from '@/services/canonicalDataService';

export const GET = withApiHandler(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const userId = sp.get('userId') ? Number(sp.get('userId')) : undefined;
  const portfolios = await getPortfolios(userId);
  return { data: portfolios, count: portfolios.length };
});
