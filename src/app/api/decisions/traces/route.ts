// GET /api/decisions/traces — List decision traces with filtering
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { listDecisionTraces } from '@/services/decisionTraceBuilder';

export const GET = withApiHandler(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const result = await listDecisionTraces({
    ticker: sp.get('ticker') ?? undefined,
    decision: sp.get('decision') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : 50,
    offset: sp.get('offset') ? Number(sp.get('offset')) : 0,
  });
  return { data: result.traces, total: result.total, count: result.traces.length };
});
