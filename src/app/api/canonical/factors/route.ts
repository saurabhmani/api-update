// GET /api/canonical/factors — List all factors (optionally filtered by category)
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { getFactors } from '@/services/canonicalDataService';

export const GET = withApiHandler(async (req: NextRequest) => {
  const category = req.nextUrl.searchParams.get('category') ?? undefined;
  const factors = await getFactors(category);
  return { data: factors, count: factors.length };
});
