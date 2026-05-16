// GET /api/canonical/positions — Canonical positions for a portfolio
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { getPositions } from '@/services/canonicalDataService';

export const GET = withApiHandler(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const portfolioId = sp.get('portfolioId');
  if (!portfolioId) throw new ValidationError('portfolioId is required');

  const positions = await getPositions(Number(portfolioId));
  return { data: positions, count: positions.length };
});
