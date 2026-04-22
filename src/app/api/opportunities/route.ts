// GET /api/opportunities — List normalized opportunities
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { getOpportunities } from '@/services/opportunityService';

export const GET = withApiHandler(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const result = await getOpportunities({
    limit: sp.get('limit') ? Number(sp.get('limit')) : 50,
    offset: sp.get('offset') ? Number(sp.get('offset')) : 0,
    direction: sp.get('direction') ?? undefined,
    minConfidence: sp.get('minConfidence') ? Number(sp.get('minConfidence')) : undefined,
    sector: sp.get('sector') ?? undefined,
  });
  return { data: result.opportunities, count: result.count, total: result.total, asOf: result.asOf };
});
