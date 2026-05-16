// GET /api/opportunities/ranked — Top-ranked actionable opportunities
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { getRankedOpportunities } from '@/services/opportunityService';

export const GET = withApiHandler(async (req: NextRequest) => {
  const limit = req.nextUrl.searchParams.get('limit') ? Number(req.nextUrl.searchParams.get('limit')) : 20;
  const opportunities = await getRankedOpportunities({ limit });
  return { data: opportunities, count: opportunities.length };
});
