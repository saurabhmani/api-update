// GET /api/explainability/decision/:id — Full decision trace
//
// PRD: Explainability derived from decision trace only.
// Accepts a decisionId (e.g. DEC-xxx-0001) and returns the full
// institutional decision trace from decisionTraceBuilder.
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { NotFoundError } from '@/lib/errors';
import { getDecisionTraceById } from '@/services/decisionTraceBuilder';

export const GET = withApiHandler(async (req: NextRequest, ctx: any) => {
  const decisionId = String(ctx?.params?.id ?? req.nextUrl.searchParams.get('id') ?? '');
  if (!decisionId) {
    throw new NotFoundError('Decision', 'invalid id');
  }

  const trace = await getDecisionTraceById(decisionId);
  if (!trace) throw new NotFoundError('Decision', decisionId);

  return { data: trace };
});
